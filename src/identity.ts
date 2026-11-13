/**
 * How this package identifies itself to the gateway. OpenCode asks clients to name themselves rather
 * than look like a generic SDK, and to send a stable session id so it can route and cache prompts —
 * the Go endpoints refuse a request that carries none, so one is always sent.
 */
export const USER_AGENT = 'cortico-provider-opencode/0.6.3';
export const SESSION_HEADER = 'x-opencode-session';

/**
 * A request without a conversation id — the connectivity probe is one — still needs a session id, so
 * the endpoint keeps one of its own. It is stable for the life of the instance, which is what the
 * gateway asks for.
 */
export function newSession(): string {
  return crypto.randomUUID();
}

/**
 * One id for calls that have no conversation of their own, such as a model-list request. Stable for the
 * life of the process, because the gateway asks for a stable id rather than a new one per call.
 */
const PROBE_SESSION = newSession();

/**
 * The gateway reads an empty header value as a header that is not there and refuses the request, so an
 * empty argument takes the probe id instead of going out as an empty string.
 */
export function identityHeaders(session: string): Record<string, string> {
  const id = typeof session === 'string' && session.trim() ? session.trim() : PROBE_SESSION;
  return { 'User-Agent': USER_AGENT, [SESSION_HEADER]: id };
}
