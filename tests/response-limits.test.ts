import { describe, expect, it } from 'vitest';
import { MAX_MESSAGES_TOOL_CALLS, MessagesAssembly } from '../src/anthropic.ts';
import { GeminiAssembly } from '../src/gemini.ts';
import { MAX_SIGNATURE_BYTES, MAX_SIGNATURE_STORE_BYTES, SignatureStore } from '../src/signatures.ts';

const ignore = (): void => {};

function startTool(assembly: MessagesAssembly, index: number): void {
  assembly.feed({ type: 'content_block_start', index, content_block: {
    type: 'tool_use', id: `c${index}`, name: 't',
  } }, ignore);
}

function argumentsDelta(assembly: MessagesAssembly, index: number, partial: string): void {
  assembly.feed({ type: 'content_block_delta', index, delta: {
    type: 'input_json_delta', partial_json: partial,
  } }, ignore);
}

describe('Messages tool buffer limits', () => {
  it('rejects excess arguments before an unfinished block is handed to the transport', () => {
    const assembly = new MessagesAssembly({ model: 'fixture', input: [], max_output_tokens: 1 } as never);
    startTool(assembly, 0);
    argumentsDelta(assembly, 0, 'x'.repeat(9));
    expect(() => argumentsDelta(assembly, 0, 'x')).toThrow('output character limit');
  });

  it('counts arguments across tool blocks without resetting the budget at a block boundary', () => {
    const assembly = new MessagesAssembly({ model: 'fixture', input: [], max_output_tokens: 2 } as never);
    startTool(assembly, 0);
    argumentsDelta(assembly, 0, '{"x":1}');
    assembly.feed({ type: 'content_block_stop', index: 0 }, ignore);
    startTool(assembly, 1);
    expect(() => argumentsDelta(assembly, 1, 'x'.repeat(12))).toThrow('output character limit');
  });

  it('bounds arguments when the request omits an output token limit', () => {
    const assembly = new MessagesAssembly({ model: 'fixture', input: [] } as never);
    startTool(assembly, 0);
    expect(() => argumentsDelta(assembly, 0, 'x'.repeat(32768 * 12 + 1))).toThrow('output character limit');
  });

  it.each(['id', 'name'])('bounds an oversized tool %s before retaining the block', field => {
    const assembly = new MessagesAssembly({ model: 'fixture', input: [], max_output_tokens: 1 } as never);
    expect(() => assembly.feed({ type: 'content_block_start', index: 0, content_block: {
      type: 'tool_use', id: 'c', name: 't', [field]: 'x'.repeat(12),
    } }, ignore)).toThrow('output character limit');
  });

  it('shares the character budget between tool identities and arguments', () => {
    const assembly = new MessagesAssembly({ model: 'fixture', input: [], max_output_tokens: 1 } as never);
    startTool(assembly, 0);
    expect(() => argumentsDelta(assembly, 0, 'x'.repeat(10))).toThrow('output character limit');
  });

  it('bounds the number of empty tool blocks independently of their character count', () => {
    const assembly = new MessagesAssembly({ model: 'fixture', input: [] } as never);
    const add = (index: number): void => assembly.feed({ type: 'content_block_start', index, content_block: {
      type: 'tool_use', id: '', name: '',
    } }, ignore);
    for (let index = 0; index < MAX_MESSAGES_TOOL_CALLS; index++) add(index);
    expect(() => add(MAX_MESSAGES_TOOL_CALLS)).toThrow('tool block limit');
  });
});

describe('Gemini signature cache limits', () => {
  it('uses the replay fallback for an oversized signature without failing the response', () => {
    const store = new SignatureStore();
    const assembly = new GeminiAssembly({ model: 'fixture', input: [] } as never, store);
    assembly.feed({ candidates: [{ content: { parts: [{
      functionCall: { name: 'fixture_tool', args: {} },
      thoughtSignature: 's'.repeat(MAX_SIGNATURE_BYTES + 1),
    }] }, finishReason: 'STOP' }] }, ignore);
    const response = assembly.finish(ignore);
    const call = response.output.find(item => item.type === 'function_call')!;
    expect(response.status).toBe('completed');
    expect(store.size).toBe(0);
    expect(store.replay(call.call_id)).toBe(SignatureStore.SKIP);
  });

  it('measures UTF-8 bytes and removes a stale value when its replacement is too large', () => {
    const store = new SignatureStore();
    store.set('call', 'previous');
    store.set('call', '界'.repeat(Math.floor(MAX_SIGNATURE_BYTES / 3) + 1));
    expect(store.replay('call')).toBe(SignatureStore.SKIP);
  });

  it('evicts oldest entries when the total byte budget is reached', () => {
    const store = new SignatureStore();
    const signature = 's'.repeat(MAX_SIGNATURE_BYTES);
    const capacity = MAX_SIGNATURE_STORE_BYTES / MAX_SIGNATURE_BYTES;
    for (let index = 0; index <= capacity; index++) store.set(`call_${index}`, signature);
    expect(store.size).toBe(capacity);
    expect(store.replay('call_0')).toBe(SignatureStore.SKIP);
    expect(store.get(`call_${capacity}`)).toBe(signature);
  });

  it('releases the old byte count when a cached signature is replaced', () => {
    const store = new SignatureStore();
    const signature = 's'.repeat(MAX_SIGNATURE_BYTES);
    const capacity = MAX_SIGNATURE_STORE_BYTES / MAX_SIGNATURE_BYTES;
    for (let index = 0; index < capacity; index++) store.set(`call_${index}`, signature);
    store.set('call_0', 'replacement');
    store.set('extra', 'extra');
    expect(store.size).toBe(capacity + 1);
    expect(store.get('call_1')).toBe(signature);
    expect(store.get('call_0')).toBe('replacement');
  });
});
