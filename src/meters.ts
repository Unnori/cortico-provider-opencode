import { priceUsage, type Generation, type PriceRule, type ProviderAttempt } from 'cortico/core/generation.ts';
import { snapshotPrice } from 'cortico/providers/pricebook.ts';

const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const BALANCE_METER = 'opencode_balance_charge';

function reconcileCharges(attempt: ProviderAttempt, reported: number | undefined): void {
  const quotes = attempt.charges.map(charge => charge.quote)
    .filter(quote => reported === undefined || quote.basis !== 'marginal');
  attempt.charges = priceUsage(attempt.meters, quotes, attempt.serviceTier);
  if (reported === undefined) return;

  // The gateway reports the total in USD. Preserve it without allocating it to token lines.
  const rule = { meter: `detail:${BALANCE_METER}`, perMillion: 1_000_000, unit: 'USD' } satisfies PriceRule;
  const details = attempt.meters.details ??= {};
  details[BALANCE_METER] = { quantity: reported, unit: rule.unit };
  const quote = snapshotPrice({
    models: [attempt.origin.model], currency: 'USD', basis: 'marginal',
    source: 'OpenCode reported balance charge', rules: [rule],
  }, { startedAt: attempt.startedAt, requestedServiceTier: attempt.requestedServiceTier ?? null });
  attempt.charges.push({
    quote, amount: reported, knownAmount: reported, missing: [],
    lines: [{ ...rule, quantity: reported, amount: reported }],
  });
}

/** Preserve the gateway's billed token breakdown and settle balance charges from its usage. */
export function applyGatewayMeters(generation: Pick<Generation, 'attempts'>, mediaTypes: ReadonlySet<string> = new Set()): void {
  for (const attempt of generation.attempts) {
    const raw = attempt.meters.native as Record<string, any> | null;
    const gateway = raw?.opencode;
    const tokens = gateway?.tokens;
    const reported = gateway?.billing_source === 'balance' && gateway.estimated !== true && count(raw?.cost)
      ? raw.cost : undefined;
    const meters = attempt.meters;
    const details = { ...meters.details };
    for (const modality of ['audio', 'image', 'video']) if (!mediaTypes.has(modality)) {
      details[`${modality}_input`] = { quantity: 0, unit: 'token' };
    }
    meters.details = details;
    if (!tokens || typeof tokens !== 'object') {
      reconcileCharges(attempt, reported);
      continue;
    }
    if (count(tokens.input)) meters.uncachedInput = tokens.input;
    if (count(tokens.cache_read)) meters.cachedInput = tokens.cache_read;
    if (count(tokens.output)) meters.output = tokens.output;
    if (count(tokens.reasoning)) meters.reasoning = tokens.reasoning;
    const writes = Object.entries(tokens).filter(([key, value]) => /^cache_write(?:_|$)/.test(key) && count(value));
    for (const [key, value] of writes) details[key] = { quantity: value as number, unit: 'token' };
    if (!count(tokens.cache_write) && writes.length) details.cache_write = { quantity: writes.reduce((sum, [, value]) => sum + (value as number), 0), unit: 'token' };
    if (details.cache_write?.quantity === 0) {
      for (const charge of attempt.charges) for (const rule of charge.quote.rules) {
        if (rule.meter.startsWith('detail:cache_write_')) details[rule.meter.slice(7)] = { quantity: 0, unit: 'token' };
      }
    }
    for (const modality of ['audio', 'image', 'video']) for (const direction of ['input', 'output']) {
      const value = tokens[`${direction}_${modality}`] ?? tokens[`${modality}_${direction}`];
      if (count(value)) details[`${modality}_${direction}`] = { quantity: value, unit: 'token' };
    }
    if (count(meters.uncachedInput) && count(meters.cachedInput)) {
      meters.input = meters.uncachedInput + meters.cachedInput + (details.cache_write?.quantity ?? 0);
      if (count(meters.output)) meters.total = meters.input + meters.output;
    }
    reconcileCharges(attempt, reported);
  }
}
