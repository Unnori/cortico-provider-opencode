/**
 * The per-endpoint choices. All live in `options.*` so an endpoint stays plain Cortico config:
 * `protocol` picks the request shape, `billing` picks the account that pays, `keys` lists the secret
 * variable names this endpoint may use with one after another.
 */
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { Protocol } from './address.ts';
import type { Billing } from './pricing.ts';

export const BILLING_OPTIONS: readonly Billing[] = ['go', 'balance'];

/** A Go subscription is what most accounts have, and it is the one with allowance windows to show. */
export const DEFAULT_BILLING: Billing = 'go';

/** OpenCode's own examples take the API default; a new endpoint starts here and the operator can change it. */
export const DEFAULT_TEMPERATURE = 1;

/** The output cap OpenCode's examples state, used when the endpoint states none. */
export const DEFAULT_MAX_TOKENS = 8192;

/** Chat is the faster path here: most Go models are Chat-native, so Responses has to be translated. */
export const DEFAULT_PROTOCOL: Protocol = 'chat';

/** The effort sent when thinking is on and the endpoint states no level. */
export const DEFAULT_EFFORT = 'medium';

/** The lowest level Gemini accepts. It is the closest a Gemini request gets to "no thinking". */
export const MINIMUM_GEMINI_LEVEL = 'LOW';

export interface OpenCodeOptions {
  /** Unset: chat. */
  protocol?: Protocol;
  /** Unset: `go`. */
  billing?: Billing;
  /**
   * Secret variable names in priority order, separated by semicolons. The endpoint spends the first key
   * until the account refuses it, then moves to the next; empty or a single name means no rotation.
   */
  keys?: string;
}

export const optionsOf = (entry: LLMProviderEntry): OpenCodeOptions => (entry.options ?? {}) as OpenCodeOptions;

export const protocolOf = (entry: LLMProviderEntry): Protocol => optionsOf(entry).protocol ?? DEFAULT_PROTOCOL;

export const billingOf = (entry: LLMProviderEntry): Billing => optionsOf(entry).billing ?? DEFAULT_BILLING;

/**
 * The key names this endpoint may use, in the order it must try them. `entry.secret` stays first so a
 * single-key endpoint behaves exactly as before, and a second name can only be reached when the
 * operator listed one.
 */
export function keyNamesOf(entry: LLMProviderEntry): string[] {
  const listed = optionsOf(entry).keys;
  const extra = typeof listed === 'string' ? listed.split(/[;,\s]+/) : [];
  const names = [entry.secret, ...extra]
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim());
  return [...new Set(names)];
}
