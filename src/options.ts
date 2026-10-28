/**
 * The two per-endpoint choices. Both live in `options.*` so an endpoint stays plain Cortico config:
 * `protocol` picks the request shape, `billing` picks the account that pays.
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

export interface OpenCodeOptions {
  /** Unset: chat. */
  protocol?: Protocol;
  /** Unset: `go`. */
  billing?: Billing;
}

export const optionsOf = (entry: LLMProviderEntry): OpenCodeOptions => (entry.options ?? {}) as OpenCodeOptions;

export const protocolOf = (entry: LLMProviderEntry): Protocol => optionsOf(entry).protocol ?? DEFAULT_PROTOCOL;

export const billingOf = (entry: LLMProviderEntry): Billing => optionsOf(entry).billing ?? DEFAULT_BILLING;
