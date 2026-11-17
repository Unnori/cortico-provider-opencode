import { afterEach, describe, expect, it, vi } from 'vitest';
import { functionCall, functionResult, message, record } from 'cortico/protocol/open-responses/context.ts';
import { attachmentWindow } from '../src/attachment-window.ts';
import { prepareAttachments } from '../src/attachments.ts';
import { OpenCodeProvider } from '../src/native.ts';

const pdf = Buffer.from('%PDF-1.7\nwindow document\n%%EOF');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const wav = Buffer.from('RIFF1234WAVEfmt window audio');
const video = Buffer.from('\x00\x00\x00\x18ftypisomwindow video', 'latin1');
const bytes = { pdf, gif, wav, video };
const mimes = { pdf: 'application/pdf', gif: 'image/gif', wav: 'audio/wav', video: 'video/mp4' };
const refs = Object.keys(bytes).map(handle => ({ handle, mime: mimes[handle as keyof typeof mimes], name: `${handle}.bin`, fallbackText: `[${handle} attachment]` }));
const facts = { input: Object.values(mimes) };
const read = (handle: string) => bytes[handle as keyof typeof bytes] ?? null;
const policy = { protocol: 'gemini' as const, facts, read };
const frame = (id: string, blobs = refs) => [functionCall(id, 'external_event_frame', '{}'), functionResult(id, 'external message', { blobs })];
afterEach(() => vi.unstubAllGlobals());

describe('attachment delivery window', () => {
  it('keeps the current user delivery through repeated tool calls and process-independent replays', () => {
    const initial = [message('user', 'analyze', { blobs: refs })];
    const toolLoop = [...initial, functionCall('read', 'inspect_file', '{}'), functionResult('read', 'details'),
      functionCall('draw', 'draw', '{}'), functionResult('draw', 'done')];
    const original = structuredClone(toolLoop);
    for (let replay = 0; replay < 2; replay++) {
      expect(prepareAttachments({ input: [] }, { context: toolLoop }, policy).hashes).toHaveLength(4);
    }
    expect(attachmentWindow(toolLoop)).toBe(0);
    expect(toolLoop).toEqual(original);
  });

  it('removes every old media kind on a new user delivery without reading bytes or changing stored analysis', () => {
    const context = [...frame('old'), message('assistant', 'analysis of all files'), message('user', 'another question')];
    const original = structuredClone(context);
    const reader = vi.fn(read);
    const result = prepareAttachments({ input: [] }, { context }, { ...policy, read: reader });
    expect(result.hashes).toHaveLength(0);
    expect(reader).not.toHaveBeenCalled();
    expect(JSON.stringify(result.options.context)).toContain('analysis of all files');
    for (const ref of refs) expect(JSON.stringify(result.options.context)).toContain(ref.fallbackText);
    expect(context).toEqual(original);
  });

  it('treats ordinary user messages and external frames delivered together as the same batch', () => {
    const context = [message('user', 'operator message', { blobs: refs.slice(0, 1) }), ...frame('latest', refs.slice(1)),
      functionCall('tool', 'inspect_file', '{}'), functionResult('tool', 'result')];
    expect(attachmentWindow(context)).toBe(0);
    expect(prepareAttachments({ input: [] }, { context }, policy).hashes).toHaveLength(4);
  });

  it('expires old external frames and preserves all media in the latest external frame', () => {
    const context = [...frame('old'), message('assistant', 'previous analysis'), ...frame('new', refs.slice(0, 1))];
    const reader = vi.fn(read);
    expect(prepareAttachments({ input: [] }, { context }, { ...policy, read: reader }).hashes).toHaveLength(1);
    expect(reader.mock.calls).toEqual([['pdf']]);
  });

  it('does not let synthetic head messages or reasoning turn a tool loop into a new delivery', () => {
    const context = [...frame('files'), message('assistant', 'working'), functionCall('t', 'inspect_file', '{}'),
      functionResult('t', 'details'), message('user', 'synthetic notice', { head: true }),
      record({ type: 'reasoning', id: 'rs_head', summary: [] }, { head: true })];
    expect(attachmentWindow(context)).toBe(0);
    expect(prepareAttachments({ input: [] }, { context }, policy).hashes).toHaveLength(4);
  });

  it('keeps tool media that has not been sent yet when a new delivery arrives after its result', () => {
    const context = [message('user', 'old input'), functionCall('t', 'read_file', '{}'),
      functionResult('t', 'new tool file', { blobs: refs }), ...frame('new', [])];
    expect(attachmentWindow(context)).toBe(2);
    expect(prepareAttachments({ input: [] }, { context }, policy).hashes).toHaveLength(4);
  });

  it('recognizes frame sidecar metadata even if only the result survives a context handoff', () => {
    const context = [message('user', 'old', { blobs: refs }), message('assistant', 'done'),
      functionResult('restored', 'new external delivery', { frame: { events: [] }, blobs: refs.slice(0, 1) })];
    expect(attachmentWindow(context)).toBe(2);
    expect(prepareAttachments({ input: [] }, { context }, policy).hashes).toHaveLength(1);
  });

  it('strips historical inline media without decoding it and allows explicitly reattached file handles', () => {
    const old = record({ type: 'message', role: 'user', content: Object.entries(bytes).map(([kind, value]) => ({
      type: kind === 'gif' ? 'input_image' : 'input_file',
      ...(kind === 'gif' ? { image_url: `data:image/gif;base64,${value.toString('base64')}` }
        : { filename: `${kind}.bin`, file_data: `data:${mimes[kind as keyof typeof mimes]};base64,${value.toString('base64')}` }),
    })) } as any);
    const context = [old, message('assistant', 'analysis'), message('user', 'read PDF again'),
      functionCall('reopen', 'read_file', '{}'), functionResult('reopen', 'reattached original', { blobs: refs.slice(0, 1) })];
    const original = structuredClone(context);
    const result = prepareAttachments({ input: [] }, { context }, policy);
    expect(result.hashes).toHaveLength(1);
    expect(JSON.stringify(result.options.context)).toContain(pdf.toString('base64'));
    for (const value of [gif, wav, video]) expect(JSON.stringify(result.options.context)).not.toContain(value.toString('base64'));
    expect(JSON.stringify(result.options.context)).toContain('Previous attachment');
    expect(context).toEqual(original);
  });

  it('ignores expired files when checking the request size budget', () => {
    const context = [message('user', 'old', { blobs: refs }), message('assistant', 'done'), message('user', 'new', { blobs: refs.slice(0, 1) })];
    const reader = vi.fn(read);
    const result = prepareAttachments({ input: [] }, { context }, { ...policy, read: reader });
    expect(result.hashes).toHaveLength(1);
    expect(reader.mock.calls).toEqual([['pdf']]);
  });
});

const answer = (protocol: string) => protocol === 'responses' ? { id: 'resp_window', model: 'fixture', status: 'completed', output: [] }
  : protocol === 'anthropic' ? { id: 'msg_window', type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
    : protocol === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }
      : { id: 'chat_window', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };

describe('attachment window on the final HTTP wire', () => {
  it.each(['chat', 'responses', 'anthropic', 'gemini'] as const)('retains %s batch media during tools, expires it on the next delivery and supports reattachment', async protocol => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(String(init.body)); return new Response(JSON.stringify(answer(protocol))); }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol, keepThinking: () => false,
      attachments: () => ({ protocol, facts, read }) });
    const current = frame('files');
    const send = (context: typeof current) => client.respond({ model: 'fixture', input: [] }, { context });
    await send(current);
    const tools = [...current, functionCall('t', 'inspect_file', '{}'), functionResult('t', 'details')];
    await send(tools);
    const next = [...tools, message('assistant', 'file analysis'), message('user', 'next question')];
    await send(next);
    for (const kind of ['pdf', 'gif'] as const) {
      expect(bodies[0]).toContain(bytes[kind].toString('base64'));
      expect(bodies[1]).toContain(bytes[kind].toString('base64'));
      expect(bodies[2]).not.toContain(bytes[kind].toString('base64'));
    }
    for (const kind of ['wav', 'video'] as const) {
      expect(bodies[0].includes(bytes[kind].toString('base64'))).toBe(protocol === 'gemini');
      expect(bodies[1].includes(bytes[kind].toString('base64'))).toBe(protocol === 'gemini');
      expect(bodies[2]).not.toContain(bytes[kind].toString('base64'));
    }
    expect(bodies[2]).toContain('file analysis');
    for (const ref of refs) expect(bodies[2]).toContain(ref.fallbackText);
    await send([...next, functionCall('reopen', 'read_file', '{}'), functionResult('reopen', 'PDF again', { blobs: refs.slice(0, 1) })]);
    expect(bodies[3]).toContain(pdf.toString('base64'));
    expect(bodies[3]).not.toContain(gif.toString('base64'));
  });
});
