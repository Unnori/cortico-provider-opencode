import { describe, expect, it } from 'vitest';
import { MessagesAssembly, parseMessages } from '../src/anthropic.ts';

const request = { model: 'claude-haiku-5-5', input: [] } as never;

/** The usage block the gateway actually sends on message_start. */
const startUsage = {
  input_tokens: 13,
  output_tokens: 3,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** The fuller block message_delta sends, as observed on the live gateway. */
const deltaUsage = {
  input_tokens: 13,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 4,
};

describe('Messages usage', () => {
  it('keeps the counts message_start carries, so a stream cut before message_delta still meters', () => {
    const assembly = new MessagesAssembly(request);
    const emit = (): void => {};
    assembly.feed({ type: 'message_start', message: { id: 'msg_1', model: 'claude-haiku-5-5', usage: startUsage } }, emit as never);
    assembly.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }, emit as never);
    // Nothing closes the stream: this is the shape that used to record null tokens.
    const response = assembly.finish(emit as never);
    expect(response.status).toBe('completed');
    expect(assembly.meters().input).toBe(13);
    expect(assembly.meters().output).toBe(3);
    expect(assembly.meters().total).toBe(16);
  });

  it('lets message_delta refine the counts without losing the input side', () => {
    const assembly = new MessagesAssembly(request);
    const emit = (): void => {};
    assembly.feed({ type: 'message_start', message: { id: 'msg_1', model: 'm', usage: startUsage } }, emit as never);
    assembly.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }, emit as never);
    assembly.feed({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: deltaUsage }, emit as never);
    assembly.finish(emit as never);
    const meters = assembly.meters();
    // The transport defines `prompt_tokens` as the whole prompt including what was cached, and derives
    // uncached as prompt minus cached. Anthropic's input_tokens excludes the cache, so it is added back.
    expect(meters.input).toBe(17);
    expect(meters.cachedInput).toBe(4);
    expect(meters.uncachedInput).toBe(13);
    expect(meters.output).toBe(5);
  });

  it('adds the cached read to the prompt side, which is what the upstream counts', () => {
    const assembly = new MessagesAssembly(request);
    const emit = (): void => {};
    assembly.feed({ type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } } }, emit as never);
    assembly.finish(emit as never);
    // input_tokens excludes cache reads on this API, so the prompt is 100 and the cache 90.
    expect(assembly.meters().input).toBe(100);
    expect(assembly.meters().cachedInput).toBe(90);
    expect(assembly.meters().uncachedInput).toBe(10);
  });

  it('meters a non-streamed reply from its top-level usage', () => {
    const parsed = parseMessages({
      id: 'msg_1',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }, request);
    expect(parsed.meters.input).toBe(20);
    expect(parsed.meters.output).toBe(7);
  });

  it('reports unknown rather than zero when the stream carried no usage at all', () => {
    const assembly = new MessagesAssembly(request);
    const emit = (): void => {};
    assembly.feed({ type: 'message_start', message: { id: 'm', model: 'm' } }, emit as never);
    assembly.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }, emit as never);
    assembly.finish(emit as never);
    expect(assembly.meters().input).toBeNull();
    expect(assembly.meters().output).toBeNull();
  });
});
