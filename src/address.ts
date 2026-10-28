/**
 * One gateway serves every OpenCode API family, and a Go subscription reaches the same families under
 * an extra `/go` segment: `/inference/go/openai/v1` bills the subscription while
 * `/inference/openai/v1` bills the Console balance. An endpoint's base URL names the gateway; the
 * protocol option picks the family path and the billing option picks the segment, so the three
 * families are reachable from one address.
 */
import type { Billing } from './pricing.ts';

export type Protocol = 'responses' | 'chat' | 'anthropic' | 'gemini';

export const PROTOCOLS: readonly Protocol[] = ['responses', 'chat', 'anthropic', 'gemini'];

export interface Gateway {
  /** Origin and the `/inference` prefix, without a trailing slash. */
  root: string;
}

const MARKER = '/inference';

/** The two OpenAI protocols share a family path; Messages and Gemini each have their own. */
export function familyOf(protocol: Protocol): string {
  if (protocol === 'anthropic') return 'anthropic/v1';
  if (protocol === 'gemini') return 'google/v1beta';
  return 'openai/v1';
}

/**
 * The gateway an endpoint URL points at, or null for any other host — a proxy or a self-hosted
 * gateway keeps its URL verbatim.
 */
export function parseGateway(baseUrl: string): Gateway | null {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return null; }
  const at = url.pathname.indexOf(MARKER);
  if (at < 0) return null;
  return { root: `${url.origin}${url.pathname.slice(0, at + MARKER.length)}`.replace(/\/+$/, '') };
}

/** The base URL one account and protocol are reached at; the framework appends the request path. */
export function baseUrlOf(gateway: Gateway, billing: Billing, protocol: Protocol): string {
  return `${gateway.root}${billing === 'go' ? '/go' : ''}/${familyOf(protocol)}`;
}

/** The model list sits on the gateway root rather than under the family path: `<root>/v1/models`. */
export function modelListUrl(gateway: Gateway, billing: Billing): string {
  return `${gateway.root}${billing === 'go' ? '/go' : ''}/v1/models`;
}

/** Only a Go subscription has allowance windows to read. */
export function usageUrl(gateway: Gateway): string {
  return `${gateway.root}/go/v1/usage`;
}
