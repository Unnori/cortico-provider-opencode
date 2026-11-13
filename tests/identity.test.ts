import { describe, expect, it } from 'vitest';
import { identityHeaders, SESSION_HEADER, USER_AGENT } from '../src/identity.ts';

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
});
