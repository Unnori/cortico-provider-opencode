/**
 * The Go allowance windows. `GET <root>/go/v1/usage` answers with the three windows the Go page
 * defines — `rolling` (5 hours), `weekly`, `monthly` — each with a percentage and the moment it resets.
 * The endpoint is not in OpenCode's published API reference, so a failed read is reported rather than
 * retried, and the panel keeps what it last saw.
 *
 * Between reads the bars can also move on this process's own spend: each finished generation reports
 * its charge, and the Go page states a model's monthly allowance, so dollars spent on a model convert
 * to a share of each window (5 hours = 20% of the monthly limit, weekly 50%, monthly 100%).
 */
import { usageUrl, type Gateway } from './address.ts';
import { WINDOW_SHARE, monthlyLimit, type UsageWindow } from './pricing.ts';
import { identityHeaders } from './identity.ts';

export interface UsageWindowState {
  status: 'ok' | 'rate-limited';
  /** 0–100, as the gateway reports it. */
  percent: number;
  resetsAt: string;
}

export interface GoUsage {
  rolling: UsageWindowState;
  weekly: UsageWindowState;
  monthly: UsageWindowState;
}

const WINDOWS: readonly UsageWindow[] = ['rolling', 'weekly', 'monthly'];
const MAX_BYTES = 64 * 1024;

function windowOf(raw: unknown): UsageWindowState {
  const row = raw as { status?: unknown; percent?: unknown; resetsAt?: unknown } | null;
  if (!row || (row.status !== 'ok' && row.status !== 'rate-limited')) throw new Error('usage window lacks a status');
  if (typeof row.percent !== 'number' || !Number.isFinite(row.percent) || row.percent < 0 || row.percent > 100)
    throw new Error('usage window lacks a percentage');
  if (typeof row.resetsAt !== 'string' || !Number.isFinite(Date.parse(row.resetsAt)))
    throw new Error('usage window lacks a reset time');
  return { status: row.status, percent: row.percent, resetsAt: row.resetsAt };
}

/** Validates one response body; the windows are what the panel draws, so a missing one is an error. */
export function parseUsage(raw: unknown): GoUsage {
  const body = raw as { usage?: Record<string, unknown> } | null;
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') throw new Error('OpenCode usage: no usage object');
  return {
    rolling: windowOf(usage.rolling),
    weekly: windowOf(usage.weekly),
    monthly: windowOf(usage.monthly),
  };
}

/**
 * The key header to try, in order. Inference takes `Authorization: Bearer`; a usage endpoint that
 * answers AuthError to that may still read the key from `x-api-key`, so a rejected key is retried once
 * the other way and the one that works is remembered for the rest of the process.
 */
const AUTH_VARIANTS: ReadonlyArray<[string, (key: string) => Record<string, string>]> = [
  ['bearer', (key) => ({ Authorization: `Bearer ${key}` })],
  ['x-api-key', (key) => ({ 'x-api-key': key })],
];

const accepted = new Map<string, string>();

export async function readUsage(
  gateway: Gateway,
  apiKey: string | undefined,
  session: string,
  signal?: AbortSignal,
): Promise<GoUsage> {
  const url = usageUrl(gateway);
  const preferred = accepted.get(gateway.root);
  const variants = preferred ? AUTH_VARIANTS.filter(([id]) => id === preferred) : AUTH_VARIANTS;
  const tried: string[] = [];
  let last: Error | null = null;
  for (const [id, header] of variants) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...identityHeaders(session), ...(apiKey ? header(apiKey) : {}) },
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    if (response.ok) {
      if (text.length > MAX_BYTES) throw new Error('OpenCode usage: response too large');
      if (apiKey) accepted.set(gateway.root, id);
      return parseUsage(JSON.parse(text));
    }
    // The body says why, and whether a key went out at all separates "we sent nothing" from "the key
    // was refused" — inference and the usage endpoint do not always agree on a key.
    const detail = text.trim().slice(0, 200);
    const auth = apiKey ? `key sent via ${id}, ${apiKey.length} chars` : 'no key';
    last = new Error(`OpenCode usage: HTTP ${response.status} [${auth}]${detail ? ` — ${detail}` : ''}`);
    tried.push(`${id}: ${response.status}`);
    // Only a rejected credential is worth retrying another way; a server error is not.
    if (!apiKey || (response.status !== 401 && response.status !== 403)) break;
  }
  if (last && tried.length > 1) last = new Error(`${last.message} (tried ${tried.join(', ')})`);
  throw last ?? new Error('OpenCode usage: no request was made');
}

/**
 * The share of each window this process's own spend accounts for, in percent, from dollars per model.
 * Null when no model in the ledger states a monthly allowance — the page lists one for every model it
 * counts, so null means the spend cannot be attributed.
 */
export function advancePercent(spend: Readonly<Record<string, number>>, window: UsageWindow): number | null {
  let percent = 0;
  let attributed = false;
  for (const [model, usd] of Object.entries(spend)) {
    const limit = monthlyLimit(model);
    if (limit === null || limit <= 0 || !Number.isFinite(usd) || usd <= 0) continue;
    attributed = true;
    percent += (usd / (limit * WINDOW_SHARE[window])) * 100;
  }
  return attributed ? percent : null;
}

/** Dollars this process spent per model since the last successful read. */
export type LocalSpend = Readonly<Record<string, number>>;

/** What the allowance panel can ask one endpoint, carried on `ProviderInstance.control`. */
export interface UsageControl {
  /** Reads the gateway's allowance windows and clears the local ledger. */
  read(): Promise<GoUsage>;
  /** Whether the endpoint's key is readable right now; the panel asks before spending a request. */
  hasKey(): boolean;
  /** Dollars this process spent per model since the last read. */
  spend(): LocalSpend;
  /** The share of one window the local spend accounts for, in percent. */
  advance(window: UsageWindow): number | null;
}

export { WINDOWS };
