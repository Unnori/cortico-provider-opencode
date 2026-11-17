import type { PriceDefinition } from 'cortico/providers/pricebook.ts';
import type { PriceRule } from 'cortico/core/generation.ts';
import type { Billing } from './pricing.ts';

export interface ModelFacts {
  name?: string;
  context?: number;
  output?: number;
  images?: boolean;
  input?: string[];
  cost?: Record<string, any>;
  monthlyUsage?: Record<string, number>;
}

export function factsOf(raw: Record<string, any>): ModelFacts {
  const input = Array.isArray(raw.modalities?.input)
    ? raw.modalities.input.filter((value: unknown): value is string => typeof value === 'string') : undefined;
  const limit = raw.limit ?? {};
  return {
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
    ...(Number.isFinite(limit.context) && limit.context > 0 ? { context: limit.context } : {}),
    ...(Number.isFinite(limit.output) && limit.output > 0 ? { output: limit.output } : {}),
    ...(input ? { input, images: input.some((mime: string) => mime === 'image' || mime.startsWith('image/')) }
      : raw.attachment === true ? { images: true } : {}),
    ...(raw.cost && typeof raw.cost === 'object' ? { cost: raw.cost } : {}),
    ...(raw.go?.monthly_usage ? { monthlyUsage: raw.go.monthly_usage } : {}),
  };
}

const aliases: Record<string, string> = {
  'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
  'audio/m4a': 'audio/mp4', 'video/mov': 'video/quicktime', 'video/avi': 'video/x-msvideo',
};
export function canonicalMime(mime: string): string {
  const normalized = mime.split(';')[0].trim().toLowerCase();
  return aliases[normalized] ?? normalized;
}

/** Exact MIME declarations win; broad models.dev modalities only fill missing gateway metadata. */
export function declaredInput(facts: ModelFacts | undefined, mime: string): boolean {
  mime = canonicalMime(mime);
  if (!Array.isArray(facts?.input)) return false;
  return facts.input.some(value => canonicalMime(value) === mime
    || (value === 'pdf' && mime === 'application/pdf')
    || (['image', 'audio', 'video'].includes(value) && mime.startsWith(`${value}/`)));
}

function matches(when: any, at: Date, context?: number, depth = 0): boolean {
  if (!when || typeof when !== 'object' || depth > 16) return false;
  for (const [key, value] of Object.entries(when) as [string, any][]) {
    if (key === 'all') { if (!Array.isArray(value) || !value.every(v => matches(v, at, context, depth + 1))) return false; continue; }
    if (key === 'any') { if (!Array.isArray(value) || !value.some(v => matches(v, at, context, depth + 1))) return false; continue; }
    const actual = key === 'context' ? context : key === 'date' ? at.toISOString().slice(0, 10)
      : key === 'utc_hours' ? at.toISOString().slice(11, 16)
        : key === 'utc_days' ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][at.getUTCDay()] : undefined;
    if (actual === undefined || !value || typeof value !== 'object') return false;
    for (const [op, expected] of Object.entries(value) as [string, any][]) {
      if (op === 'gt' ? !(actual > expected) : op === 'gte' ? !(actual >= expected)
        : op === 'lt' ? !(actual < expected) : op === 'lte' ? !(actual <= expected)
          : op === 'in' ? !Array.isArray(expected) || !expected.includes(actual) : true) return false;
    }
  }
  return true;
}

/** Gateway cost prices are USD per million tokens, including cache duration and modality rates. */
export function metadataPrice(model: string, facts: ModelFacts | undefined, billing: Billing, startedAt: string): PriceDefinition | undefined {
  const cost = facts?.cost;
  if (!cost) return undefined;
  const at = new Date(startedAt);
  if (!Number.isFinite(at.getTime())) return undefined;
  let factor = 1;
  for (const multiplier of Array.isArray(cost.multipliers) ? cost.multipliers : []) {
    if (Number.isFinite(multiplier?.factor) && multiplier.factor >= 0 && matches(multiplier.when, at)) factor *= multiplier.factor;
  }
  const scalar = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const rulesAt = (context: number): PriceRule[] => {
    const result: PriceRule[] = [];
    const add = (meter: string, value: unknown) => { if (scalar(value)) result.push({ meter: meter as PriceRule['meter'], perMillion: value * factor }); };
    const rate = (raw: any): any => {
      let value = raw ?? {};
      for (const override of Array.isArray(raw?.overrides) ? raw.overrides : []) if (matches(override?.when, at, context)) value = { ...value, ...override };
      return value;
    };
    if (cost.text) {
      const input = rate(cost.text.input);
      const output = rate(cost.text.output);
      add('uncachedInput', input.price); add('output', output.price); add('cachedInput', input.cache?.read);
      const write = input.cache?.write;
      if (scalar(write)) add('detail:cache_write', write);
      else if (write && typeof write === 'object') for (const [duration, price] of Object.entries(write)) add(`detail:cache_write_${duration}`, price);
      for (const modality of ['audio', 'image', 'video']) {
        add(`detail:${modality}_input`, rate(cost[modality]?.input).price);
        add(`detail:${modality}_output`, rate(cost[modality]?.output).price);
      }
    } else {
      // Account-specific models.dev uses the flat cost schema.
      add('uncachedInput', cost.input); add('output', cost.output); add('cachedInput', cost.cache_read);
      add('detail:cache_write', cost.cache_write); add('detail:audio_input', cost.input_audio);
    }
    return result;
  };
  const base = rulesAt(0);
  if (!base.length) return undefined;
  const thresholds = new Set<number>();
  for (const modality of ['text', 'audio', 'image', 'video']) for (const direction of ['input', 'output']) {
    const overrides = cost[modality]?.[direction]?.overrides;
    for (const override of Array.isArray(overrides) ? overrides : []) {
      const condition = override.when?.context;
      if (scalar(condition?.gt)) thresholds.add(condition.gt + 1);
      else if (scalar(condition?.gte) && condition.gte > 0) thresholds.add(condition.gte);
    }
  }
  return {
    models: [model], currency: 'USD', basis: billing === 'go' ? 'equivalent' : 'marginal',
    source: 'OpenCode model metadata', rules: base,
    ...(thresholds.size ? { inputBands: [...thresholds].sort((a, b) => a - b).map(from => ({ from, rules: rulesAt(from) })) } : {}),
  };
}
