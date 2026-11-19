import { describe, expect, it, vi } from 'vitest';
import { identityHeaders, SESSION_HEADER, USER_AGENT } from '../src/identity.ts';
import { OpenCodeProvider } from '../src/native.ts';

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

  it.each([
    ['chat', { id: 'chat', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }],
    ['responses', { id: 'resp', model: 'fixture', output: [], status: 'completed' }],
    ['anthropic', { id: 'msg', model: 'fixture', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }],
    ['gemini', { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }],
  ] as const)('keeps the %s request session when a different conversation starts before a retry', async (protocol, answer) => {
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
});
