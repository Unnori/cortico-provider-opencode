import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { ProviderHost } from 'cortico/providers/base.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { prepareAttachments, supportsAttachment, MAX_ATTACHMENT_BYTES } from '../src/attachments.ts';
import { OpenCodeProvider } from '../src/native.ts';
import type { Protocol } from '../src/address.ts';
import OPENCODE from '../src/index.ts';

const pdf = Buffer.from('%PDF-1.7\nfixture document\n%%EOF');
const wav = Buffer.from('RIFF1234WAVEfmt fixture audio');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const facts = { input: ['text', 'image/gif', 'audio/wav', 'application/pdf'] };
const history = [message('user', 'read these', { blobs: [
  { handle: 'pdf', mime: 'application/pdf', name: 'report.pdf', fallbackText: '[report.pdf]' },
  { handle: 'wav', mime: 'audio/wav', name: 'voice.wav', fallbackText: '[voice.wav]' },
  { handle: 'zip', mime: 'application/zip', fallbackText: '[archive.zip]' },
] })];
const read = (handle: string) => ({ pdf, wav, zip: Buffer.from('PK\x03\x04') })[handle] ?? null;
afterEach(() => vi.unstubAllGlobals());

describe('declared attachment inputs', () => {
  it('checks exact MIME declarations, aliases, manual switches and protocol support', () => {
    const policy = { facts, protocol: 'gemini' as const };
    expect(supportsAttachment(policy, 'audio/x-wav')).toBe(true);
    expect(supportsAttachment(policy, 'audio/flac')).toBe(false);
    expect(supportsAttachment({ ...policy, enabled: false }, 'application/pdf')).toBe(false);
    expect(supportsAttachment({ ...policy, audio: false }, 'audio/wav')).toBe(false);
    expect(supportsAttachment({ ...policy, files: false }, 'application/pdf')).toBe(false);
    expect(supportsAttachment({ ...policy, images: false }, 'image/gif')).toBe(false);
    expect(supportsAttachment({ ...policy, protocol: 'anthropic' }, 'audio/wav')).toBe(false);
    expect(supportsAttachment({ ...policy, protocol: 'responses' }, 'audio/wav')).toBe(false);
    expect(supportsAttachment({ ...policy, protocol: 'chat' }, 'audio/wav')).toBe(false);
    expect(supportsAttachment({ protocol: 'gemini' }, 'application/pdf')).toBe(false);
  });

  it('sends admitted bytes, drops undeclared media and preserves original history and fallback text', () => {
    const original = structuredClone(history);
    const result = prepareAttachments({ input: [] }, { context: history }, { facts, protocol: 'gemini', read });
    const serialized = JSON.stringify(result.options.context);
    expect(serialized).toContain(pdf.toString('base64'));
    expect(serialized).toContain(wav.toString('base64'));
    expect(serialized).not.toContain(Buffer.from('PK\x03\x04').toString('base64'));
    expect(serialized).toContain('[archive.zip]');
    expect(history).toEqual(original);
  });

  it('keeps PDFs native when audio is manually disabled and keeps audio native when files are disabled', () => {
    const noAudio = prepareAttachments({ input: [] }, { context: history }, { facts, protocol: 'gemini', read, audio: false });
    expect(JSON.stringify(noAudio.options.context)).not.toContain(wav.toString('base64'));
    expect(JSON.stringify(noAudio.options.context)).toContain(pdf.toString('base64'));
    const noFiles = prepareAttachments({ input: [] }, { context: history }, { facts, protocol: 'gemini', read, files: false });
    expect(JSON.stringify(noFiles.options.context)).not.toContain(pdf.toString('base64'));
    expect(JSON.stringify(noFiles.options.context)).toContain(wav.toString('base64'));
  });

  it('uses real bytes for mislabeled media and rejects oversized / invalid inline data', () => {
    const request: Request = { input: [{ type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: `data:image/png;base64,${gif.toString('base64')}` },
      { type: 'input_file', file_data: 'data:application/pdf;base64,???' },
    ] }] };
    const policy = { facts: { input: ['image/png', 'application/pdf'] }, protocol: 'gemini' as const, read: () => Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) };
    const result = prepareAttachments(request, {}, policy);
    expect(JSON.stringify(result)).not.toContain(gif.toString('base64'));
    expect(JSON.stringify(result)).toContain('omitted');
    expect(prepareAttachments({ input: [] }, { context: history }, policy).hashes).toEqual([]);
  });
});

function response(protocol: Protocol) {
  return protocol === 'responses' ? { id: 'resp_fixture', model: 'fixture', status: 'completed', output: [] }
    : protocol === 'anthropic' ? { id: 'msg_fixture', type: 'message', model: 'fixture', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
      : protocol === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }
        : { id: 'chat_fixture', model: 'fixture', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
}

describe('native wire attachments', () => {
  it('preserves native attachments delivered through Core external event tool results', async () => {
    const video = Buffer.from('\x00\x00\x00\x18ftypisomfixture video', 'latin1');
    const payloads = { pdf, wav, gif, video };
    const mimes = ['application/pdf', 'audio/wav', 'image/gif', 'video/mp4'];
    const context = [
      functionCall('event_1', 'external_event_frame', '{}'),
      functionResult('event_1', 'received files', { blobs: Object.keys(payloads).map((handle, i) => ({
        handle, mime: mimes[i], name: `${handle}.bin`, fallbackText: `[${handle}]`,
      })) }),
    ];
    const original = structuredClone(context);
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(response('gemini')));
    }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'gemini', keepThinking: () => false,
      attachments: () => ({ facts: { input: mimes }, protocol: 'gemini', read: handle => payloads[handle as keyof typeof payloads] ?? null }),
    });
    await client.respond({ model: 'fixture', input: [] }, { context });
    const contents = bodies[0].contents;
    expect(contents[0].parts[0].functionCall.name).toBe('external_event_frame');
    expect(contents[1].parts).toHaveLength(1);
    expect(contents[1].parts[0].functionResponse.response.result).toContain('received files');
    expect(contents[2].parts.map((part: any) => part.inlineData.mimeType)).toEqual(mimes);
    expect(contents[2].parts.map((part: any) => Buffer.from(part.inlineData.data, 'base64'))).toEqual(Object.values(payloads));
    expect(context).toEqual(original);
  });

  it('keeps parallel tool responses together and emits their media after the full response group', async () => {
    const context = [
      functionCall('a', 'read_one', '{}'), functionCall('b', 'read_two', '{}'),
      functionResult('a', 'first', { blobs: [{ handle: 'pdf', mime: 'application/pdf', fallbackText: '[pdf]' }] }),
      functionResult('b', 'second', { blobs: [{ handle: 'wav', mime: 'audio/wav', fallbackText: '[wav]' }] }),
      message('user', 'inspect both'),
      functionCall('c', 'next_step', '{}'), functionResult('c', 'done'),
    ];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(response('gemini'))); }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'gemini', keepThinking: () => false,
      attachments: () => ({ facts, protocol: 'gemini', read }),
    });
    await client.respond({ model: 'fixture', input: [] }, { context });
    const contents = bodies[0].contents;
    expect(contents[0].parts).toHaveLength(2);
    expect(contents[1].parts.map((part: any) => part.functionResponse.name)).toEqual(['read_one', 'read_two']);
    expect(contents[2].parts.filter((part: any) => part.inlineData).map((part: any) => part.inlineData.mimeType)).toEqual(['application/pdf', 'audio/wav']);
    expect(contents[2].parts.at(-1)).toEqual({ text: 'inspect both' });
    expect(contents[3].parts[0].functionCall.name).toBe('next_step');
    expect(contents[4].parts[0].functionResponse.name).toBe('next_step');
  });

  it('keeps media beside its original result group when replaying multiple external event frames', async () => {
    const context = [
      functionCall('frame_1', 'external_event_frame', '{}'),
      functionResult('frame_1', 'first event', { blobs: [{ handle: 'pdf', mime: 'application/pdf', fallbackText: '[pdf]' }] }),
      message('assistant', 'first answer'),
      functionCall('frame_2', 'external_event_frame', '{}'),
      functionResult('frame_2', 'second event', { blobs: [{ handle: 'wav', mime: 'audio/wav', fallbackText: '[wav]' }] }),
    ];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(response('gemini'))); }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'gemini', keepThinking: () => false,
      attachments: () => ({ facts, protocol: 'gemini', read }),
    });
    await client.respond({ model: 'fixture', input: [] }, { context });
    const contents = bodies[0].contents;
    expect(contents).toHaveLength(6);
    expect(contents[1].parts[0].functionResponse.response.result).toContain('first event');
    expect(contents[2].parts).toEqual([{ inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') } }]);
    expect(contents[3].parts[0]).toEqual({ text: 'first answer' });
    expect(contents[4].parts[0].functionResponse.response.result).toContain('second event');
    expect(contents[5].parts).toEqual([{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }]);
  });

  it('retries rejected Gemini tool-result media as text once and keeps its quarantine on replay', async () => {
    const context = [
      functionCall('frame', 'external_event_frame', '{}'),
      functionResult('frame', 'received files', { blobs: history[0].context.blobs }),
    ];
    const original = structuredClone(context);
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? new Response(JSON.stringify({ error: { message: 'Unsupported file format' } }), { status: 400 })
        : new Response(JSON.stringify(response('gemini')));
    }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'gemini', keepThinking: () => false,
      attachments: () => ({ facts, protocol: 'gemini', read }),
    });
    const generation = await client.respond({ model: 'fixture', input: [] }, { context });
    expect(generation.attempts).toHaveLength(2);
    expect(bodies[0].contents.flatMap((turn: any) => turn.parts).filter((part: any) => part.inlineData)).toHaveLength(2);
    await client.respond({ model: 'fixture', input: [] }, { context });
    expect(bodies).toHaveLength(3);
    for (const body of bodies.slice(1)) {
      expect(body.contents.flatMap((turn: any) => turn.parts).some((part: any) => part.inlineData)).toBe(false);
      const toolResult = body.contents[1].parts[0].functionResponse.response.result;
      expect(toolResult).toContain('received files');
      for (const name of ['report.pdf', 'voice.wav', 'archive.zip']) expect(toolResult).toContain(`[${name}]`);
    }
    expect(context).toEqual(original);
  });

  it('preserves Messages tool-result images and documents, and uses text when attachments are disabled', async () => {
    const context = [
      functionCall('frame', 'external_event_frame', '{}'),
      functionResult('frame', 'received files', { blobs: [...history[0].context.blobs!,
        { handle: 'gif', mime: 'image/gif', fallbackText: '[image.gif]' },
      ] }),
    ];
    const original = structuredClone(context);
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(response('anthropic'))); }));
    let enabled = true;
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'anthropic', keepThinking: () => false,
      attachments: () => ({ facts, protocol: 'anthropic', enabled, read: handle => handle === 'gif' ? gif : read(handle) }),
    });
    await client.respond({ model: 'fixture', input: [] }, { context });
    const result = bodies[0].messages[1].content[0];
    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('frame');
    expect(result.content.filter((block: any) => block.type !== 'text')).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') }, title: 'report.pdf' },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: gif.toString('base64') } },
    ]);
    expect(JSON.stringify(result.content)).toContain('received files');
    expect(JSON.stringify(result.content)).toContain('[voice.wav]');
    expect(JSON.stringify(result.content)).not.toContain(wav.toString('base64'));
    enabled = false;
    await client.respond({ model: 'fixture', input: [] }, { context });
    const text = bodies[1].messages[1].content[0].content;
    expect(typeof text).toBe('string');
    expect(text).toContain('received files');
    expect(text).toContain('[report.pdf]');
    expect(text).toContain('[image.gif]');
    expect(context).toEqual(original);
  });

  it('rechecks saved switches, the request model and refreshed declarations on every request in the same instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-live-attachments-'));
    const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisomfixture video')]);
    const payloads = { pdf, wav, gif, video };
    const mimes = ['application/pdf', 'audio/wav', 'image/gif', 'video/mp4'];
    const context = [message('user', 'inspect attachments', { blobs: Object.keys(payloads).map((handle, i) => ({
      handle, mime: mimes[i], fallbackText: `[${handle}]`,
    })) })];
    const original = structuredClone(context);
    let entry: LLMProviderEntry = { kind: 'opencode', baseUrl: 'https://live-attachments.invalid', multimodal: true,
      options: { protocol: 'gemini' }, spec: { model: 'media-model', thinking: false } };
    const cache = (input: string[]) => writeFileSync(join(dir, 'models.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(), models: { 'media-model': { input }, 'text-model': { input: ['text'] } },
    }));
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify(response('gemini')));
    }));
    try {
      cache(['text', ...mimes]);
      const instance = OPENCODE.create('fixture', entry, {
        stateDir: dir, currentEntry: () => entry, secret: () => '', keepThinking: () => false,
        readBlob: handle => payloads[handle as keyof typeof payloads] ?? null,
        log: nullLogger(),
      } satisfies ProviderHost);
      const send = async (expected: boolean) => {
        await instance.client.respond({ model: entry.spec!.model, input: [] }, { context });
        const body = bodies.at(-1)!;
        for (const bytes of Object.values(payloads)) expect(body.includes(bytes.toString('base64'))).toBe(expected);
        for (const mime of mimes) expect(OPENCODE.accepts(entry, entry.spec!, mime)).toBe(expected);
        expect(context).toEqual(original);
      };
      await send(true);
      // Replace the entry object, as a saved configuration update does; do not mutate the old entry.
      entry = { ...entry, multimodal: false, options: { ...entry.options, inputAudio: false, inputVideo: false, inputFiles: false } };
      await send(false);
      entry = { ...entry, multimodal: true, options: { protocol: 'gemini' } };
      await send(true);
      entry = { ...entry, spec: { ...entry.spec!, model: 'text-model' } };
      await send(false);
      entry = { ...entry, spec: { ...entry.spec!, model: 'media-model' } };
      await send(true);
      cache(['text']);
      await send(false);
      expect(bodies).toHaveLength(6);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['chat', 'responses', 'anthropic', 'gemini'] as const)('encodes PDF and protocol-compatible audio in %s', async protocol => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(response(protocol))); }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol, keepThinking: () => false,
      attachments: () => ({ facts, protocol, read }),
    });
    await client.respond({ model: 'fixture', input: [] }, { context: history });
    const body = JSON.stringify(bodies[0]);
    expect(body).toContain(pdf.toString('base64'));
    expect(body).toContain('[archive.zip]');
    expect(body).not.toContain('UEsDBA==');
    if (protocol === 'gemini') {
      expect(body).toContain('inlineData'); expect(body).toContain('audio/wav');
    }
    else expect(body).not.toContain(wav.toString('base64'));
    if (protocol === 'anthropic') expect(body).toContain('"type":"document"');
  });

  it('retries a media rejection once, quarantines the rejected bytes for that model and keeps history', async () => {
    const original = structuredClone(history);
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: 'Unsupported media format' } }), { status: 400 });
      return new Response(JSON.stringify(response('chat')));
    }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'chat', keepThinking: () => false,
      attachments: () => ({ facts, protocol: 'chat', read }),
    });
    const result = await client.respond({ model: 'fixture', input: [] }, { context: history });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain(pdf.toString('base64'));
    expect(bodies[1]).not.toContain(pdf.toString('base64'));
    expect(result.attempts).toHaveLength(2);
    await client.respond({ model: 'fixture', input: [] }, { context: history });
    expect(bodies[2]).not.toContain(pdf.toString('base64'));
    expect(history).toEqual(original);
  });

  it('does not retry unrelated HTTP failures as text', async () => {
    const fetch = vi.fn(async () => new Response('{"error":{"message":"Invalid model"}}', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'chat', keepThinking: () => false, attachments: () => ({ facts, protocol: 'chat', read }) });
    await expect(client.respond({ model: 'fixture', input: [] }, { context: history })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops after a failed text fallback and retains both attempts', async () => {
    const fetch = vi.fn(async () => new Response('{"error":{"message":"Unsupported image format"}}', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol: 'chat', keepThinking: () => false, attachments: () => ({ facts, protocol: 'chat', read }) });
    const failure = await client.respond({ model: 'fixture', input: [] }, { context: history }).catch(error => error);
    expect(failure.attempts).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('honors a text-only declaration after switching away from an audio model', () => {
    const audio = prepareAttachments({ model: 'audio', input: [] }, { context: history }, { facts, protocol: 'gemini', read });
    expect(audio.hashes).toHaveLength(2);
    const text = prepareAttachments({ model: 'text', input: [] }, { context: history }, { facts: { input: ['text'] }, protocol: 'gemini', read });
    expect(text.hashes).toHaveLength(0);
    expect(JSON.stringify(text.options.context)).toContain('[voice.wav]');
    expect(JSON.stringify(text.options.context)).not.toContain(wav.toString('base64'));
  });
});
