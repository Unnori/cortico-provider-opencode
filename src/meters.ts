import { priceUsage, type Generation } from 'cortico/core/generation.ts';

/** Preserve the gateway's billed token breakdown; missing categories remain unknown. */
export function applyGatewayMeters(generation: Generation, mediaTypes: ReadonlySet<string> = new Set()): void {
  for (const attempt of generation.attempts) {
    const raw = attempt.meters.native as Record<string, any> | null;
    const tokens = raw?.opencode?.tokens;
    const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const meters = attempt.meters;
    const details = { ...meters.details };
    for (const modality of ['audio', 'image', 'video']) if (!mediaTypes.has(modality)) {
      details[`${modality}_input`] = { quantity: 0, unit: 'token' };
    }
    meters.details = details;
    if (!tokens || typeof tokens !== 'object') {
      attempt.charges = priceUsage(meters, attempt.charges.map(charge => charge.quote), attempt.serviceTier);
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
    meters.details = details;
    if (count(meters.uncachedInput) && count(meters.cachedInput)) {
      meters.input = meters.uncachedInput + meters.cachedInput + (details.cache_write?.quantity ?? 0);
      if (count(meters.output)) meters.total = meters.input + meters.output;
    }
    // Reconcile against the same request-time quote, never a later price table.
    attempt.charges = priceUsage(meters, attempt.charges.map(charge => charge.quote), attempt.serviceTier);
  }
}
