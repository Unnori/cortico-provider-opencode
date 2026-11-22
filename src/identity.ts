import { AsyncLocalStorage } from 'node:async_hooks';
import type { KeyCredential, KeyCursor } from './rotation.ts';

/**
 * How this package identifies itself to the gateway. OpenCode asks clients to name themselves rather
 * than look like a generic SDK, and to send a stable session id so it can route and cache prompts —
 * the Go endpoints refuse a request that carries none, so one is always sent.
 */
export const USER_AGENT = 'cortico-provider-opencode/0.7.2';
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

export interface RequestCredentials {
  apiKey?: string;
  keyCursor?: KeyCursor;
}

/** The HTTP transport asks for headers again on retry, after other requests may have started. */
export class RequestIdentity {
  private readonly request = new AsyncLocalStorage<{ session: string; credential: KeyCredential | null }>();
  private readonly fallback = newSession();

  constructor(private readonly credentials: RequestCredentials) {}

  run<T>(session: string | undefined, send: () => T): T {
    const id = typeof session === 'string' ? session.trim() : '';
    return this.request.run({ session: id || this.fallback, credential: null }, send);
  }

  headers(): Record<string, string> {
    const request = this.request.getStore();
    const cursor = this.credentials.keyCursor;
    const credential = cursor?.current() ?? null;
    if (request) request.credential = credential;
    const key = cursor ? credential?.value : this.credentials.apiKey;
    return {
      ...identityHeaders(request?.session ?? this.fallback),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
  }

  /** Cortico calls this after a 401/403 and retries only when it returns true. */
  keyRefused(): boolean {
    const attempted = this.request.getStore()?.credential;
    return attempted != null && this.credentials.keyCursor?.refuse(attempted) === true;
  }
}
