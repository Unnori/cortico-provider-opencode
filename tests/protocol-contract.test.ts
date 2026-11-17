import { afterEach, describe, expect, it, vi } from 'vitest';
import { functionCall, functionResult, message, record } from 'cortico/protocol/open-responses/context.ts';
import { OpenCodeProvider } from '../src/native.ts';
import { buildGeminiBody, GeminiAssembly, geminiSchema, parseGeminiResponse } from '../src/gemini.ts';
import { buildMessagesBody, MessagesAssembly, parseMessages } from '../src/anthropic.ts';
import { prepareAttachments, supportsAttachment } from '../src/attachments.ts';
import { inputCapabilities } from '../src/webui/model-settings.ts';
import { geminiThinking, messagesThinking } from '../src/protocol-contract.ts';

afterEach(() => vi.unstubAllGlobals());
const pdf = Buffer.from('%PDF-1.7\ncontract\n%%EOF');
const text = Buffer.from('中文 document');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const schema = { type: 'object', additionalProperties: false, properties: {
  layout: { type: 'object', properties: { v: { type: 'integer', enum: [1, 2] } } },
  enabled: { type: ['boolean', 'null'], enum: [true, false, null] },
  mode: { oneOf: [{ const: 'auto' }, { type: 'integer', minimum: 0 }] },
  linked: { $ref: '#/$defs/Point' },
}, $defs: { Point: { type: 'object', properties: { x: { type: 'number' } } } } };
const request = { model: 'fixture', input: 'hello', tools: [{ type: 'function' as const, name: 'draw', description: 'draw', parameters: schema }] };
const answer = (protocol: string) => protocol === 'responses' ? { id: 'resp_test', model: 'fixture', status: 'completed', output: [] }
  : protocol === 'anthropic' ? { id: 'msg_test', type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
    : protocol === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }
      : { id: 'chat_test', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };

describe('documented protocol contracts', () => {
  it.each(['chat', 'responses', 'anthropic', 'gemini'] as const)('keeps numeric enums and schema constraints on the %s HTTP wire', async protocol => {
    let body: any;
    const original = structuredClone(request);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify(answer(protocol))); }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol, keepThinking: () => false });
    await client.respond(request, {});
    const tool = protocol === 'gemini' ? body.tools[0].functionDeclarations[0] : body.tools[0];
    expect(protocol === 'chat' ? tool.function.parameters : protocol === 'anthropic' ? tool.input_schema
      : protocol === 'gemini' ? tool.parametersJsonSchema : tool.parameters).toEqual(schema);
    if (protocol === 'gemini') expect(tool).not.toHaveProperty('parameters');
    expect(request).toEqual(original);
  });

  it('copies JSON Schema without coercing numeric or boolean argument types', () => {
    const clone: any = geminiSchema(schema);
    clone.properties.layout.properties.v.enum.push(3);
    expect(schema.properties.layout.properties.v.enum).toEqual([1, 2]);
    expect(geminiSchema(schema)).toEqual(schema);
  });

  it('moves Chat result media after the whole parallel result group and leaves Responses media native', async () => {
    const context = [functionCall('a', 'read_a', '{}'), functionCall('b', 'read_b', '{}'),
      functionResult('a', 'first', { blobs: [{ handle: 'pdf', mime: 'application/pdf', fallbackText: '[report.pdf]' }] }),
      functionResult('b', 'second', { blobs: [{ handle: 'gif', mime: 'image/gif', fallbackText: '[photo.gif]' }] }),
      message('user', 'continue')];
    const original = structuredClone(context);
    for (const protocol of ['chat', 'responses'] as const) {
      let body: any;
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify(answer(protocol))); }));
      const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol, keepThinking: () => false,
        attachments: () => ({ protocol, facts: { input: ['application/pdf', 'image/gif'] }, read: handle => handle === 'pdf' ? pdf : gif }) });
      await client.respond({ model: 'fixture', input: [] }, { context });
      if (protocol === 'chat') {
        expect(body.messages.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'user']);
        expect(body.messages[1].content).toContain('[report.pdf]');
        expect(typeof body.messages[2].content).toBe('string');
        expect(body.messages[3].content.map((part: any) => part.type)).toEqual(['file', 'image_url']);
      } else {
        const results = body.input.filter((item: any) => item.type === 'function_call_output');
        expect(results[0].output.some((part: any) => part.type === 'input_file')).toBe(true);
        expect(results[1].output.some((part: any) => part.type === 'input_image')).toBe(true);
      }
      expect(JSON.stringify(body)).toContain(pdf.toString('base64'));
      expect(JSON.stringify(body)).toContain(gif.toString('base64'));
    }
    expect(context).toEqual(original);
  });

  it('uses the documented Messages text document source and keeps it in the tool result', () => {
    const context = [functionCall('a', 'read', '{}'), functionResult('a', 'read', {
      blobs: [{ handle: 'text', mime: 'text/plain', name: 'note.txt', fallbackText: '[note.txt]' }],
    })];
    const request = { model: 'fixture', input: [] };
    const prepared = prepareAttachments(request, { context }, { protocol: 'anthropic', facts: { input: ['text/plain'] }, read: () => text });
    const body: any = buildMessagesBody(request, prepared.options);
    const source = body.messages[1].content[0].content.find((block: any) => block.type === 'document').source;
    expect(source).toEqual({ type: 'text', media_type: 'text/plain', data: '中文 document' });
  });

  it.each(['chat', 'responses', 'anthropic'] as const)('intersects model declarations with %s wire MIME constraints', protocol => {
    const policy = { protocol, facts: { input: ['image/heic', 'image/svg+xml', 'image/png', 'application/zip', 'application/pdf', 'text/plain'] } };
    expect(supportsAttachment(policy, 'image/heic')).toBe(false);
    expect(supportsAttachment(policy, 'image/svg+xml')).toBe(false);
    expect(supportsAttachment(policy, 'application/zip')).toBe(false);
    expect(supportsAttachment(policy, 'image/png')).toBe(true);
    expect(supportsAttachment(policy, 'application/pdf')).toBe(true);
    expect(supportsAttachment(policy, 'text/plain')).toBe(protocol !== 'chat');
  });

  it('shows supported plain text documents under the file switch and honors that switch', () => {
    const entry = { kind: 'opencode', baseUrl: 'https://fixture.invalid', spec: { model: 'fixture', thinking: false }, options: { protocol: 'anthropic' } };
    const facts = { input: ['text/plain'] };
    expect(inputCapabilities(entry, facts).inputs.find(input => input.kind === 'file')?.enabled).toBe(true);
    expect(inputCapabilities({ ...entry, options: { ...entry.options, inputFiles: false } }, facts, ['text/plain']).accepts['text/plain']).toBe(false);
  });

  it.each(['chat', 'responses'] as const)('drops animated or truncated GIFs before %s transport without changing stored history', protocol => {
    const descriptor = gif.indexOf(Buffer.from([0x2c]));
    const animated = Buffer.concat([gif.subarray(0, gif.length - 1), gif.subarray(descriptor)]);
    const request = { input: [] };
    const context = [message('user', 'image', { blobs: [{ handle: 'gif', mime: 'image/gif', fallbackText: '[gif]' }] })];
    for (const bytes of [animated, gif.subarray(0, 12)]) {
      const prepared = prepareAttachments(request, { context }, { protocol, facts: { input: ['image/gif'] }, read: () => bytes });
      expect(prepared.hashes).toHaveLength(0);
      expect(JSON.stringify(prepared.options.context)).toContain('[gif]');
    }
    expect(prepareAttachments(request, { context }, { protocol, facts: { input: ['image/gif'] }, read: () => gif }).hashes).toHaveLength(1);
  });

  it('keeps fallback text when reading media throws or a text document has invalid UTF-8', () => {
    const context = [message('user', 'read', { blobs: [{ handle: 'x', mime: 'text/plain', fallbackText: '[document]' }] })];
    for (const read of [() => { throw new Error('missing file'); }, () => Buffer.from([0xff])]) {
      const result = prepareAttachments({ input: [] }, { context }, { protocol: 'anthropic', facts: { input: ['text/plain'] }, read });
      expect(result.hashes).toHaveLength(0);
      expect(JSON.stringify(result.options.context)).toContain('[document]');
    }
  });

  it('keeps Gemini thought tokens and gateway cost in unary and final-usage stream chunks', () => {
    const usage = { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 7, totalTokenCount: 19, cost: 0.4,
      opencode: { billing_source: 'go', tokens: { input: 10, output: 9 } } };
    const raw = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: usage };
    const unary = parseGeminiResponse(raw, { input: [] });
    const assembly = new GeminiAssembly({ input: [] });
    assembly.feed({ candidates: raw.candidates }, () => {});
    assembly.feed({ usageMetadata: usage }, () => {});
    assembly.finish(() => {});
    for (const meters of [unary.meters, assembly.meters()]) {
      expect(meters.output).toBe(9);
      expect(meters.reasoning).toBe(7);
      expect(meters.total).toBe(19);
      expect(meters.native).toMatchObject({ cost: 0.4, opencode: usage.opencode });
    }
    expect(parseMessages({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1, cost: 0.2 } }, { input: [] }).meters.native).toMatchObject({ cost: 0.2 });
  });

  it('surfaces blocked prompts and invalid Gemini function calls as failures', () => {
    for (const raw of [{ promptFeedback: { blockReason: 'SAFETY' } }, { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }]) {
      expect(() => parseGeminiResponse(raw, { input: [] })).toThrow();
    }
  });

  it('uses model-specific documented thinking modes and leaves unknown models unset', () => {
    const spec = { thinking: false, maxTokens: 4096 };
    expect(geminiThinking({ ...spec, model: 'gemini-4-argon' })).toEqual({ thinkingLevel: 'LOW' });
    expect(geminiThinking({ ...spec, model: 'gemini-3.1-flash-lite' })).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(geminiThinking({ ...spec, model: 'gemini-2.5-flash' })).toEqual({ thinkingBudget: 0 });
    expect(geminiThinking({ ...spec, model: 'gemini-2.5-pro' })).toEqual({ thinkingBudget: 128 });
    expect(geminiThinking({ ...spec, model: 'gemini-2.5-flash', thinking: true })).toEqual({ thinkingBudget: -1 });
    expect(geminiThinking({ ...spec, model: 'gemini-3-pro-preview', thinking: true, reasoningEffort: 'medium' })).toEqual({ thinkingLevel: 'HIGH' });
    expect(geminiThinking({ ...spec, model: 'unknown' })).toBeUndefined();
    expect(messagesThinking({ ...spec, model: 'claude-opus-5-5' })).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    expect(messagesThinking({ ...spec, model: 'claude-sonnet-5-5' })).toEqual({ thinking: { type: 'between_tools' } });
    expect(messagesThinking({ ...spec, model: 'claude-sonnet-4-5', thinking: true })).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } });
    expect(() => messagesThinking({ ...spec, model: 'claude-sonnet-4-5', thinking: true, maxTokens: 256 })).toThrow('greater than 1024');
    expect(messagesThinking({ ...spec, model: 'unknown' })).toEqual({});
  });

  it.each(['gemini', 'anthropic'] as const)('retains partial %s text as incomplete after a real SSE stream closes early', async protocol => {
    const chunks = protocol === 'gemini' ? [{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }]
      : [{ type: 'message_start', message: { id: 'msg_cut', model: 'fixture' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }];
    const fetch = vi.fn(async () => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol, keepThinking: () => false });
    const generation = await client.respond({ model: 'fixture', input: 'hi' }, { onEvent() {} });
    expect(generation.response.status).toBe('incomplete');
    expect(generation.response.incomplete_details?.reason).toBe('stream_interrupted');
    expect(JSON.stringify(generation.response.output)).toContain('partial');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not interpret the ordinary text modality as permission to upload arbitrary text files', () => {
    expect(supportsAttachment({ protocol: 'gemini', facts: { input: ['text'] } }, 'text/plain')).toBe(false);
    expect(supportsAttachment({ protocol: 'gemini', facts: { input: ['text/plain'] } }, 'text/plain')).toBe(true);
  });

  it('replays exact signed and redacted Messages thinking with the matching tool turn', () => {
    const model = 'claude-sonnet-4-5';
    const blocks = [{ type: 'thinking', thinking: 'inspect the file', signature: 'SIGNED' },
      { type: 'redacted_thinking', data: 'OPAQUE' }];
    const parsed = parseMessages({ id: 'msg_signed', model, content: [...blocks,
      { type: 'tool_use', id: 'read', name: 'draw', input: { layout: { v: 2 } } }], stop_reason: 'tool_use' }, { model, input: [] });
    const context = [message('user', 'draw'), ...parsed.response.output.map(item => record(item)), functionResult('read', 'done')];
    const body: any = buildMessagesBody({ model, input: [] }, { context });
    expect(body.messages[1].content.slice(0, 2)).toEqual(blocks);
    expect(body.messages[1].content[2].type).toBe('tool_use');
    expect(body.messages[1].content[2].input.layout.v).toBe(2);
    expect((buildMessagesBody({ model: 'claude-haiku-5-5', input: [] }, { context }) as any).messages[1].content.some((block: any) => block.type === 'thinking')).toBe(false);
  });

  it('maps tool choice to native Gemini and Messages fields without changing Responses/Chat contracts', () => {
    for (const [tool_choice, gemini, messages] of [
      ['none', { mode: 'NONE' }, { type: 'none' }],
      ['required', { mode: 'ANY' }, { type: 'any' }],
      [{ type: 'function', name: 'draw' }, { mode: 'ANY', allowedFunctionNames: ['draw'] }, { type: 'tool', name: 'draw' }],
    ] as const) {
      const next = { ...request, tool_choice } as any;
      expect((buildGeminiBody(next, {}) as any).toolConfig.functionCallingConfig).toEqual(gemini);
      expect((buildMessagesBody(next, {}) as any).tool_choice).toEqual(messages);
    }
    expect((buildMessagesBody({ ...request, parallel_tool_calls: false }, {}) as any).tool_choice.disable_parallel_tool_use).toBe(true);
  });

  it('preserves streaming Messages signature deltas and replayed tool arguments', () => {
    const model = 'claude-opus-5';
    const assembly = new MessagesAssembly({ model, input: [] });
    const feed = (event: any) => assembly.feed(event, () => {});
    feed({ type: 'message_start', message: { id: 'msg_signed', model } });
    feed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'inspect' } });
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } });
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'NED' } });
    feed({ type: 'content_block_stop', index: 0 });
    feed({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'draw' } });
    feed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"layout":{"v":2}}' } });
    feed({ type: 'content_block_stop', index: 1 });
    feed({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    const response = assembly.finish(() => {});
    const context = [message('user', 'draw'), ...response.output.map(item => record(item)), functionResult('c1', 'done')];
    const body: any = buildMessagesBody({ model, input: [] }, { context });
    expect(body.messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'inspect', signature: 'SIGNED' });
    expect(body.messages[1].content[1].input.layout.v).toBe(2);
  });

  it('uses Responses encrypted replay and never synthesizes reasoning before external event calls', async () => {
    const origin = { instance: 'fixture', module: 'opencode', model: 'fixture', compatibilityDomain: 'fixture' };
    const context = [record({ type: 'reasoning', id: 'rs_signed', summary: [], encrypted_content: 'SEALED' }, { origin }),
      functionCall('frame', 'external_event_frame', '{}'), functionResult('frame', 'event')];
    let body: any;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify(answer('responses'))); }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'responses', keepThinking: () => true });
    await client.respond({ model: 'fixture', input: [] }, { context, origin });
    expect(body.include).toContain('reasoning.encrypted_content');
    expect(body.input.filter((item: any) => item.type === 'reasoning')).toEqual([
      expect.objectContaining({ id: 'rs_signed', encrypted_content: 'SEALED' }),
    ]);
    expect(JSON.stringify(body.input)).not.toContain('reasoning_text');
  });

  it('omits prohibited Claude sampling fields and rejects unsupported forced tools before sending', () => {
    const next = { ...request, model: 'claude-opus-5-5', temperature: 0.5 };
    const body: any = buildMessagesBody(next, {});
    expect(body).not.toHaveProperty('temperature');
    expect(() => buildMessagesBody({ ...next, tool_choice: 'required' }, {})).toThrow('does not support forced tool use');
    expect(() => buildMessagesBody({ ...request, model: 'claude-sonnet-4-5', tool_choice: 'required', reasoning: { effort: 'medium' } }, {})).toThrow('does not support forced tool use');
  });

  it('uses the documented OpenCode gateway Bearer header for Gemini', async () => {
    let headers: any;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { headers = init.headers; return new Response(JSON.stringify(answer('gemini'))); }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'gemini', apiKey: 'fixture-key', keepThinking: () => false });
    await client.respond({ model: 'gemini-4-argon', input: 'hi' });
    expect(headers.Authorization).toBe('Bearer fixture-key');
    expect(headers).not.toHaveProperty('x-goog-api-key');
  });
});
