/**
 * How this package identifies itself to the gateway. OpenCode asks clients to name themselves rather
 * than look like a generic SDK, and to send a stable session id so it can route and cache prompts —
 * the Go endpoints refuse a request that carries none, so one is always sent.
 */
export const USER_AGENT = 'cortico-provider-opencode/0.3.6';
export const SESSION_HEADER = 'x-opencode-session';

/**
 * A request without a conversation id — the connectivity probe is one — still needs a session id, so
 * the endpoint keeps one of its own. It is stable for the life of the instance, which is what the
 * gateway asks for.
 */
export function newSession(): string {
  return crypto.randomUUID();
}

export function identityHeaders(session: string): Record<string, string> {
  return { 'User-Agent': USER_AGENT, [SESSION_HEADER]: session };
}
