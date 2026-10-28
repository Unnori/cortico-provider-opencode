/**
 * OpenCode's published per-token prices in USD per million tokens, read on 2026-10-28 from
 * https://opencode.ai/v2/docs/console/models (Console balance) and .../console/go (a Go subscription).
 * The two pages state different numbers for the models they share and list different models, so each
 * has its own table; `prices()` returns the one matching how the endpoint bills.
 *
 * A row names the model, its `rates` [input, output, cached read, cached write], and optionally
 * `band` [from, input, output, cached read, cached write] for the long-prompt band the page states
 * (`> 200K tokens` starts at 200001), `reduced` for a price the page lists as discounted, and `peak`
 * for a model billed by time of day. `input` excludes cache reads and writes, which is the
 * `uncachedInput` meter; `output` includes reasoning. A `null` is a rate the page does not state,
 * and that meter is then recorded as unknown rather than guessed.
 */
import type { PriceDefinition } from 'cortico/providers/pricebook.ts';
import type { PriceRule } from 'cortico/core/generation.ts';
import type { PriceWindow } from 'cortico/core/generation.ts';

/** Which account the endpoint bills: a Go subscription's allowance, or the Console balance. */
export type Billing = 'go' | 'balance';

type Rates = readonly [input: number | null, output: number | null, read: number | null, write: number | null];

interface Row {
  id: string;
  rates: Rates;
  band?: readonly [from: number, input: number | null, output: number | null, read: number | null, write: number | null];
  reduced?: Rates;
  peak?: Rates;
  /** The Go page's monthly allowance for this model, in USD. Absent when the page states none. */
  limit?: number;
}

const CONSOLE_SOURCE = 'https://opencode.ai/v2/docs/console/models (2026-10-28)';
const GO_SOURCE = 'https://opencode.ai/v2/docs/console/go (2026-10-28)';

const CONSOLE_ROWS: readonly Row[] = [
  { id: 'beam-free', rates: [0, 0, 0, null] },
  { id: 'big-pickle', rates: [0, 0, 0, null] },
  { id: 'claude-fable-5', rates: [10, 50, 1, 12.5] },
  { id: 'claude-fable-5-1', rates: [10, 50, 0.25, 12.5] },
  { id: 'claude-haiku-4-5', rates: [1, 5, 0.1, 1.25] },
  { id: 'claude-haiku-5-5', rates: [0.1, 0.5, 0.01, 0.125], band: [100001, 0.5, 2.5, 0.05, 0.625] },
  { id: 'claude-opus-4-5', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-4-6', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-4-7', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-4-8', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-5', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-5-5', rates: [4, 20, 0.2, 5] },
  { id: 'claude-sonnet-4-5', rates: [3, 15, 0.3, 3.75], band: [200001, 6, 22.5, 0.6, 7.5] },
  { id: 'claude-sonnet-4-6', rates: [3, 15, 0.3, 3.75] },
  { id: 'claude-sonnet-5', rates: [2, 10, 0.2, 2.5] },
  { id: 'claude-sonnet-5-5', rates: [2, 10, 0.2, 2.5] },
  { id: 'deepseek-v4-pro', rates: [1.74, 3.48, 0.145, null] },
  { id: 'deepseek-v4.1-flash', rates: [0.3, 1.2, 0.006, null] },
  { id: 'deepseek-v4.1-flash-free', rates: [0, 0, 0, null] },
  { id: 'flint-40b-free', rates: [0, 0, 0, null] },
  { id: 'gemini-3-flash', rates: [0.5, 3, 0.05, null] },
  { id: 'gemini-3.1-pro', rates: [2, 12, 0.2, null], band: [200001, 4, 18, 0.4, null] },
  { id: 'gemini-3.5-flash', rates: [1.5, 9, 0.15, null] },
  { id: 'gemini-3.5-flash-lite', rates: [0.3, 2.5, 0.03, null] },
  { id: 'gemini-3.6-flash', rates: [1.5, 7.5, 0.15, null] },
  { id: 'gemini-3.7-flash', rates: [1.5, 7.5, 0.15, null] },
  { id: 'gemini-3.8-flash', rates: [1.5, 7.5, 0.15, null] },
  { id: 'gemini-4-argon', rates: [4, 20, 0.2, null], reduced: [2, 10, 0.1, null] },
  { id: 'glm-5', rates: [1, 3.2, 0.2, null] },
  { id: 'glm-5.1', rates: [1.4, 4.4, 0.26, null] },
  { id: 'glm-5.2', rates: [1.4, 4.4, 0.26, null] },
  { id: 'glm-5.3', rates: [1.4, 4.4, 0.26, null] },
  { id: 'glm-5.3-flash', rates: [0.15, 0.5, 0.03, null] },
  { id: 'glm-5.3-flash-free', rates: [0, 0, 0, null] },
  { id: 'gpt-5', rates: [1.07, 8.5, 0.107, null] },
  { id: 'gpt-5-codex', rates: [1.07, 8.5, 0.107, null] },
  { id: 'gpt-5-nano', rates: [0.05, 0.4, 0.005, null] },
  { id: 'gpt-5.1', rates: [1.07, 8.5, 0.107, null] },
  { id: 'gpt-5.1-codex', rates: [1.07, 8.5, 0.107, null] },
  { id: 'gpt-5.1-codex-max', rates: [1.25, 10, 0.125, null] },
  { id: 'gpt-5.1-codex-mini', rates: [0.25, 2, 0.025, null] },
  { id: 'gpt-5.2', rates: [1.75, 14, 0.175, null] },
  { id: 'gpt-5.2-codex', rates: [1.75, 14, 0.175, null] },
  { id: 'gpt-5.3-codex', rates: [1.75, 14, 0.175, null] },
  { id: 'gpt-5.3-codex-spark', rates: [1.75, 14, 0.175, null] },
  { id: 'gpt-5.4', rates: [2.5, 15, 0.25, null], band: [272001, 5, 22.5, 0.5, null] },
  { id: 'gpt-5.4-mini', rates: [0.75, 4.5, 0.075, null] },
  { id: 'gpt-5.4-nano', rates: [0.2, 1.25, 0.02, null] },
  { id: 'gpt-5.4-pro', rates: [30, 180, 30, null] },
  { id: 'gpt-5.5', rates: [5, 30, 0.5, null], band: [272001, 10, 45, 1, null] },
  { id: 'gpt-5.5-pro', rates: [30, 180, 30, null] },
  { id: 'gpt-5.6-luna', rates: [0.2, 1.2, 0.02, 0.25], band: [272001, 0.4, 1.8, 0.04, 0.5] },
  { id: 'gpt-5.6-sol', rates: [4, 20, 0.4, 5], band: [272001, 8, 30, 0.8, 10] },
  { id: 'gpt-5.6-terra', rates: [2, 12, 0.2, 2.5], band: [272001, 4, 18, 0.4, 5] },
  { id: 'gpt-6-astra', rates: [10, 50, 1, 12.5], band: [272001, 20, 75, 2, 25] },
  { id: 'gpt-6-luna', rates: [0.1, 0.5, 0.01, 0.125], band: [272001, 0.2, 0.75, 0.02, 0.25] },
  { id: 'gpt-6-sol', rates: [2, 10, 0.2, 2.5], band: [272001, 4, 15, 0.4, 5] },
  { id: 'gpt-6.1-sol', rates: [2, 10, 0.1, 2.5], band: [272001, 4, 15, 0.2, 5] },
  { id: 'grok-4.5', rates: [2, 6, 0.3, null], band: [200001, 4, 12, 0.6, null] },
  { id: 'grok-4.6', rates: [2, 6, 0.5, null], band: [200001, 4, 12, 1, null] },
  { id: 'grok-4.7', rates: [2, 6, 0.5, null], band: [200001, 4, 12, 1, null] },
  { id: 'grok-build-0.1', rates: [1, 2, 0.2, null] },
  { id: 'jev-1.13', rates: [0.042, 0, null, null] },
  { id: 'jev-1.13-free', rates: [0, 0, null, null] },
  { id: 'kimi-k2.5', rates: [0.6, 3, 0.1, null] },
  { id: 'kimi-k2.6', rates: [0.95, 4, 0.16, null] },
  { id: 'kimi-k2.7-code', rates: [0.95, 4, 0.19, null] },
  { id: 'kimi-k3', rates: [3, 15, 0.3, 3] },
  { id: 'mimo-v2.6-flash-free', rates: [0, 0, 0, null] },
  { id: 'minimax-m2.5', rates: [0.3, 1.2, 0.06, null] },
  { id: 'minimax-m2.7', rates: [0.3, 1.2, 0.06, null] },
  { id: 'minimax-m3', rates: [0.3, 1.2, 0.06, null] },
  { id: 'mistral-large-4', rates: [1.36, 4.18, 0.14, null], reduced: [0.68, 2.09, 0.07, null] },
  { id: 'muse-spark-1.2', rates: [1.25, 4.25, 0.15, null] },
  { id: 'muse-spark-1.3', rates: [1.25, 4.25, 0.15, null] },
  { id: 'muse-wonder-1.0', rates: [4, 20, 0.2, null] },
  { id: 'nemotron-3-ultra-free', rates: [0, 0, 0, null] },
  { id: 'nemotron-3.5-lightning-free', rates: [0, 0, 0, null] },
  { id: 'nemotron-3.5-super-vl-free', rates: [0, 0, 0, null] },
  { id: 'qwen3.5-plus', rates: [0.2, 1.2, 0.02, 0.25] },
  { id: 'qwen3.6-plus', rates: [0.5, 3, 0.05, 0.625] },
  { id: 'qwen3.8-flash', rates: [0.15, 0.47, 0.016, 0.2] },
  { id: 'qwen3.8-max', rates: [2, 6, 0.25, 2.5] },
];

const GO_ROWS: readonly Row[] = [
  { id: 'beam-free', rates: [0, 0, 0, null] },
  { id: 'claude-haiku-5-5', rates: [0.1, 0.5, 0.01, 0.125], band: [100001, 0.5, 2.5, 0.05, 0.625], limit: 15 },
  { id: 'deepseek-v4-pro', rates: [0.66, 1.98, 0.022, null], peak: [1.32, 3.96, 0.044, null], limit: 15 },
  { id: 'deepseek-v4.1-flash', rates: [0.15, 0.6, 0.003, null], peak: [0.3, 1.2, 0.006, null], limit: 80 },
  { id: 'gemini-4-argon', rates: [4, 20, 0.2, null], reduced: [2, 10, 0.1, null], limit: 30 },
  { id: 'glm-5.2', rates: [1.4, 4.4, 0.26, null], limit: 60 },
  { id: 'glm-5.3', rates: [1.4, 4.4, 0.26, null], limit: 15 },
  { id: 'glm-5.3-flash', rates: [0.15, 0.5, 0.03, null], limit: 60 },
  { id: 'gpt-5.6-luna', rates: [0.2, 1.2, 0.02, 0.25], band: [272001, 0.4, 1.8, 0.04, 0.5], limit: 15 },
  { id: 'gpt-6-luna', rates: [0.1, 0.5, 0.01, 0.125], band: [272001, 0.2, 0.75, 0.02, 0.25], limit: 15 },
  { id: 'grok-4.7', rates: [2, 6, 0.5, null], band: [200001, 4, 12, 1, null], limit: 15 },
  { id: 'hy3', rates: [0.14, 0.58, 0.035, null], limit: 60 },
  { id: 'hy4-preview', rates: [0.834, 2.501, 0.042, null], limit: 30 },
  { id: 'iceman-contributor-free', rates: [0, 0, 0, null] },
  { id: 'kimi-k2.7-code', rates: [0.95, 4, 0.19, null], limit: 60 },
  { id: 'kimi-k3', rates: [3, 15, 0.3, 3], limit: 15 },
  { id: 'kimi-k3.1-pro', rates: [2, 10, 0.2, 2], limit: 15 },
  { id: 'longcat-2.0', rates: [0.3, 1.2, 0.006, null], limit: 60 },
  { id: 'mimo-v2.5', rates: [0.14, 0.28, 0.0028, null], limit: 60 },
  { id: 'mimo-v2.5-pro', rates: [0.435, 0.87, 0.003625, null], limit: 15 },
  { id: 'mimo-v2.6-flash', rates: [0.14, 0.28, 0.0028, null], limit: 60 },
  { id: 'mimo-v2.6-pro', rates: [0.435, 0.87, 0.003625, null], limit: 15 },
  { id: 'minimax-m3', rates: [0.3, 1.2, 0.06, null], limit: 60 },
  { id: 'minimax-m3.1-flash', rates: [0.15, 0.6, 0.015, null], limit: 20 },
  { id: 'muse-spark-1.2-contributor', rates: [0.1, 0.2, 0.002, null], limit: 60 },
  { id: 'muse-spark-1.3-contributor', rates: [0.1, 0.2, 0.002, null], limit: 60 },
  { id: 'qwen3.7-plus', rates: [0.4, 1.6, 0.04, 0.5], band: [256001, 1.2, 4.8, 0.12, 1.5], limit: 60 },
  { id: 'qwen3.8-flash', rates: [0.15, 0.47, 0.016, 0.2], limit: 30 },
  { id: 'qwen3.8-max', rates: [2, 6, 0.25, 2.5], limit: 15 },
  { id: 'step-5-preview', rates: [1, 2.7, 0.1, null], limit: 15 },
];

/** A reduced price the page states a window for; `until` null means the page states no end. */
const DISCOUNTS: readonly { model: string; until: string | null }[] = [
  { model: 'gemini-4-argon', until: '2026-11-30T23:59:59.999Z' },
  { model: 'mistral-large-4', until: null },
];

/** DeepSeek on Go: 01:00–04:00 and 06:00–10:00 UTC Monday to Friday are peak, everything else off-peak. */
const PEAK_HOURS = [['01:00', '04:00'], ['06:00', '10:00']] as const;
const WORKDAYS = [1, 2, 3, 4, 5];

const rules = ([input, output, read, write]: Rates): PriceRule[] => [
  ...(read === null ? [] : [{ meter: 'cachedInput', perMillion: read } as PriceRule]),
  ...(input === null ? [] : [{ meter: 'uncachedInput', perMillion: input } as PriceRule]),
  ...(write === null ? [] : [{ meter: 'detail:cache_write', perMillion: write } as PriceRule]),
  ...(output === null ? [] : [{ meter: 'output', perMillion: output } as PriceRule]),
];

/** The built-in prices for a request started at `startedAt`, priced the way the endpoint bills. */
export function prices(billing: Billing, startedAt: string): PriceDefinition[] {
  const rows = billing === 'go' ? GO_ROWS : CONSOLE_ROWS;
  const basis = billing === 'go' ? 'equivalent' : 'marginal';
  const source = billing === 'go' ? GO_SOURCE : CONSOLE_SOURCE;
  return rows.map(({ id, rates: listed, band, reduced, peak }) => {
    const window = reduced ? DISCOUNTS.find((entry) => entry.model === id) : undefined;
    const discounted = reduced !== undefined && (window === undefined || window.until === null || startedAt < window.until);
    const timeWindows: PriceWindow[] = peak
      ? PEAK_HOURS.map(([from, to]) => ({ from, to, timezone: 'UTC', weekdays: WORKDAYS, rules: rules(peak) }))
      : [];
    return {
      models: [id], currency: 'USD', basis, source, rules: rules(discounted ? reduced : listed),
      ...(band ? { inputBands: [{ from: band[0], rules: rules([band[1], band[2], band[3], band[4]]) }] } : {}),
      ...(timeWindows.length ? { timeWindows } : {}),
    };
  });
}

/** The monthly allowance the Go page states for each model, in USD. */
const MONTHLY_LIMITS: Readonly<Record<string, number>> = Object.fromEntries(
  GO_ROWS.flatMap((row) => (row.limit === undefined ? [] : [[row.id, row.limit] as const])),
);

/** The allowance the Go page states for one model, or null when it states none. */
export function monthlyLimit(model: string): number | null {
  return MONTHLY_LIMITS[model] ?? null;
}

/**
 * Each Go allowance window as a share of the model's monthly limit, as the Go page states it:
 * 5-hour is 20%, weekly 50%, monthly 100%. 'rolling' is the page's name for the 5-hour window.
 */
export const WINDOW_SHARE = { rolling: 0.2, weekly: 0.5, monthly: 1 } as const;

export type UsageWindow = keyof typeof WINDOW_SHARE;

export { CONSOLE_ROWS, GO_ROWS, DISCOUNTS, PEAK_HOURS, MONTHLY_LIMITS, CONSOLE_SOURCE, GO_SOURCE };
