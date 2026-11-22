import { describe, expect, it, vi } from 'vitest';
import { identityHeaders, SESSION_HEADER, USER_AGENT } from '../src/identity.ts';
import { OpenCodeProvider } from '../src/native.ts';
import { createKeyCursor } from '../src/rotation.ts';

const replies = [
  ['chat', { id: 'chat', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }],
  ['responses', { id: 'resp', model: 'fixture', output: [], status: 'completed' }],
  ['anthropic', { id: 'msg', model: 'fixture', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }],
  ['gemini', { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }],
] as const;

describe('session header', () => {
  it('never goes out with an empty value, which the gateway reads as missing', () => {
    // Measured on the gateway: an empty value and no header both answer
    // `400 Request is missing x-opencode-session`, while a real id answers 200.
    for (const empty of ['', '   ']) {
      const id = identityHeaders(empty)[SESSION_HEADER];
      expect(id).toBeTruthy();
      expect(id!.trim()).not.toBe('');
    }
  });

  it('keeps the conversation id it is given', () => {
    expect(identityHeaders('conv-123')[SESSION_HEADER]).toBe('conv-123');
  });

  it('uses one stable id for calls that carry no conversation', () => {
    const first = identityHeaders('')[SESSION_HEADER];
    const second = identityHeaders('')[SESSION_HEADER];
    expect(first).toBe(second);
  });

  it('names itself, since the gateway asks clients not to look like a generic SDK', () => {
    expect(identityHeaders('x')[`User-Agent`]).toBe(USER_AGENT);
  });

  it.each(replies)('keeps the %s request session when a different conversation starts before a retry', async (protocol, answer) => {
    let started!: () => void;
    let release!: (response: Response) => void;
    const startedFirst = new Promise<void>(resolve => { started = resolve; });
    const firstResponse = new Promise<Response>(resolve => { release = resolve; });
    const sent: Array<{ session: string | null; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      sent.push({ session: new Headers(init.headers).get(SESSION_HEADER), body: String(init.body) });
      if (sent.length === 1) {
        started();
        return firstResponse;
      }
      return Response.json(answer);
    }));
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol, keepThinking: () => false });
    const first = client.respond({ model: 'fixture', input: 'first prompt' }, { sessionId: 'conversation-a' });
    try {
      await Promise.race([startedFirst, first]);
      await client.respond({ model: 'fixture', input: 'second prompt' }, { sessionId: 'conversation-b' });
      release(new Response('unavailable', { status: 503, headers: { 'Retry-After': '0' } }));
      await first;
      expect(sent.map(attempt => attempt.session)).toEqual(['conversation-a', 'conversation-b', 'conversation-a']);
      expect(sent[2].body).toBe(sent[0].body);
    } finally {
      release(new Response('cancelled fixture', { status: 400 }));
      await first.catch(() => {});
      vi.unstubAllGlobals();
    }
  });

  it.each(replies)('rotates %s to the first backup after two concurrent refusals of the same key', async (protocol, answer) => {
    const keyCursor = createKeyCursor({ names: ['primary', 'first-backup', 'second-backup'], read: name => name });
    const client = new OpenCodeProvider({ baseUrl: 'https://fixture.invalid', protocol, keyCursor, keepThinking: () => false });
    const sent: Array<{ session: string | null; authorization: string | null }> = [];
    let release!: () => void;
    const bothStarted = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const headers = new Headers(init.headers);
      sent.push({ session: headers.get(SESSION_HEADER), authorization: headers.get('authorization') });
      if (sent.length <= 2) {
        if (sent.length === 2) release();
        await bothStarted;
        return new Response('fixture refusal', { status: 403, headers: { 'Retry-After': '0' } });
      }
      return Response.json(answer);
    }));
    try {
      const request = { model: 'fixture', input: 'hello' };
      await Promise.all(['a', 'b'].map(sessionId => client.respond(request, { sessionId })));
      for (const session of ['a', 'b']) {
        expect(sent.filter(attempt => attempt.session === session).map(attempt => attempt.authorization))
          .toEqual(['Bearer primary', 'Bearer first-backup']);
      }
      expect(keyCursor.current()?.name).toBe('first-backup');
    } finally {
      release();
      vi.unstubAllGlobals();
    }
  });
});
