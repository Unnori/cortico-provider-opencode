import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalog } from '../src/catalog.ts';
import { metadataPrice, factsOf } from '../src/model-metadata.ts';
import { modelSettings, MODEL_SETTINGS_PANEL } from '../src/webui/model-settings.ts';
import { opencodeWebUi } from '../src/webui/server.ts';
import { applyGatewayMeters } from '../src/meters.ts';
import OPENCODE from '../src/index.ts';
import { unknownMeters, priceUsage, type Generation } from 'cortico/core/generation.ts';

afterEach(() => vi.unstubAllGlobals());
const cost = { text: {
  input: { price: 2, cache: { read: 0.1, write: { '30m': 2.5, '12h': 5 } }, overrides: [
    { when: { context: { gt: 100 } }, price: 4, cache: { read: 0.2, write: { '30m': 5, '12h': 10 } } },
  ] },
  output: { price: 10, overrides: [{ when: { context: { gt: 100 } }, price: 15 }] },
}, audio: { input: { price: 3 } }, multipliers: [{ when: { date: { gte: '2026-12-01' } }, factor: 2 }] };

describe('gateway model declarations and prices', () => {
  it('fills input declarations missing from legacy caches without masking fresh declarations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-legacy-metadata-'));
    try {
      const cacheFile = join(dir, 'models.json');
      writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), models: {
        'gemini-4-argon': { context: 1048576, images: true },
      } }));
      const catalog = createCatalog({ baseUrl: 'https://opencode.ai/inference/go/openai/v1', billing: 'go', cacheFile });
      expect(catalog.facts('gemini-4-argon')?.input).toContain('application/pdf');
      const entry = { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', options: { protocol: 'gemini' }, spec: { model: 'gemini-4-argon', thinking: false } };
      const state = modelSettings(entry, catalog.facts('gemini-4-argon'));
      expect(state.inputs.map(input => [input.kind, input.enabled])).toEqual([
        ['image', true], ['audio', true], ['video', true], ['file', true],
      ]);
      expect(modelSettings(entry, { input: ['text'] }).inputs.every(input => !input.enabled)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refreshes exact metadata on every model fetch, ahead of fallback model facts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-metadata-'));
    let revision = 0;
    vi.stubGlobal('fetch', vi.fn(async (input) => new Response(JSON.stringify(String(input).endsWith('/models') ? { data: [
      { id: 'fixture', name: 'Fixture', limit: { context: 5000 }, modalities: { input: revision ? ['text'] : ['text', 'audio/wav', 'application/pdf'] }, cost },
    ] } : { opencode: { models: { fixture: { modalities: { input: ['text', 'image'] }, cost: { input: 99 } } } } }))));
    try {
      const catalog = createCatalog({ baseUrl: 'https://fixture.invalid', billing: 'go', cacheFile: join(dir, 'models.json') });
      const listed = await catalog.listModels();
      expect(listed[0].inputImages).toBe(false);
      expect(catalog.facts('fixture')?.input).toEqual(['text', 'audio/wav', 'application/pdf']);
      expect(catalog.facts('fixture')?.cost).toEqual(cost);
      revision++;
      await catalog.listModels();
      expect(catalog.facts('fixture')?.input).toEqual(['text']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps duration-specific cache, audio and context/date prices without inventing missing rates', () => {
    const facts = factsOf({ cost });
    const price = metadataPrice('fixture', facts, 'go', '2026-11-17T00:00:00Z')!;
    expect(price.basis).toBe('equivalent');
    expect(price.rules).toContainEqual({ meter: 'detail:cache_write_12h', perMillion: 5 });
    expect(price.rules).toContainEqual({ meter: 'detail:audio_input', perMillion: 3 });
    expect(price.inputBands?.[0].from).toBe(101);
    expect(price.inputBands?.[0].rules).toContainEqual({ meter: 'output', perMillion: 15 });
    expect(metadataPrice('fixture', facts, 'balance', '2026-12-01T00:00:00Z')?.rules).toContainEqual({ meter: 'uncachedInput', perMillion: 4 });
    expect(metadataPrice('fixture', {}, 'go', '2026-11-17T00:00:00Z')).toBeUndefined();
  });

  it('updates automatic prices when the model changes and preserves matching manual overrides', () => {
    const entry = { kind: 'opencode', baseUrl: 'https://fixture.invalid', spec: { model: 'fixture', thinking: false } };
    const original = structuredClone(entry);
    const first = modelSettings(entry, { cost });
    expect(first.automatic).toBe(true);
    expect(first.definitions[0].rules).toContainEqual({ meter: 'uncachedInput', perMillion: 2 });
    expect(entry).toEqual(original);
    const custom = { ...first.definitions[0], source: 'webui', rules: [{ meter: 'output' as const, perMillion: 7 }] };
    const overridden = { ...entry, pricing: [custom] };
    expect(modelSettings(overridden, { cost }).automatic).toBe(false);
    expect(modelSettings(overridden, { cost }).definitions[0].rules).toEqual(custom.rules);
    const second = modelSettings({ ...overridden, spec: { ...entry.spec, model: 'another' } }, { cost: { input: 1, output: 2 } });
    expect(second.automatic).toBe(true);
    expect(second.definitions[0].models).toEqual(['another']);
  });

  it('applies price edits only to the selected model and rejects stale model edits', async () => {
    let entry: any = { kind: 'opencode', baseUrl: 'https://fixture.invalid', spec: { model: 'fixture', thinking: false } };
    const panel = opencodeWebUi({ language: 'zh', editing: true, entries: () => [{ name: 'test', entry }], instance: () => ({ client: {} as any, control: { facts: () => ({ cost }) } }), save: (_name, next) => { entry = next; } });
    const invoke = (method: string, args: any) => panel.invoke!(MODEL_SETTINGS_PANEL, method, [args]);
    const state: any = await invoke('pricing-state', { name: 'test' });
    expect(state.definitions[0].rules.length).toBeGreaterThan(3);
    await expect(invoke('pricing-save', { name: 'test', model: 'other', definitions: [] })).rejects.toThrow('Model changed');
    const definition = { ...state.definitions[0], source: 'webui' };
    await invoke('pricing-save', { name: 'test', model: 'fixture', definitions: [definition] });
    expect(entry.pricing).toEqual([definition]);
    await invoke('pricing-reset', { name: 'test', model: 'fixture' });
    expect(entry.pricing).toEqual([]);
  });

  it('persists independent input switches, shares the image flag and blocks unavailable inputs', async () => {
    let entry: any = { kind: 'opencode', baseUrl: 'https://fixture-input.invalid', options: { protocol: 'chat' }, spec: { model: 'fixture-input', thinking: false } };
    const facts = { input: ['text', 'image/png', 'audio/wav', 'application/pdf'] };
    const panel = opencodeWebUi({ language: 'zh', editing: true, entries: () => [{ name: 'test', entry }], instance: () => ({ client: {} as any, control: { facts: () => facts } }), save: (_name, next) => { entry = next; } });
    const invoke = (args: any) => panel.invoke!(MODEL_SETTINGS_PANEL, 'input-save', [{ name: 'test', model: 'fixture-input', ...args }]);
    await invoke({ kind: 'audio', enabled: false });
    expect(entry.options.inputAudio).toBe(false);
    expect(modelSettings(entry, facts).inputs.find(input => input.kind === 'file')?.enabled).toBe(true);
    await invoke({ kind: 'image', enabled: false });
    expect(entry.multimodal).toBe(false);
    await invoke({ kind: 'file', enabled: false });
    expect(entry.options.inputFiles).toBe(false);
    await expect(invoke({ kind: 'video', enabled: true })).rejects.toThrow('not supported');
    await expect(invoke({ kind: 'audio', enabled: 'false' })).rejects.toThrow('Invalid input setting');
    await expect(invoke({ kind: 'audio', enabled: true, model: 'another' })).rejects.toThrow('Model changed');
  });

  it('exposes read-only MIME discovery matching World queries and the saved image/category switches', async () => {
    let entry: any = { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', options: { protocol: 'gemini' }, spec: { model: 'gemini-4-argon', thinking: false } };
    const panel = opencodeWebUi({ language: 'zh', entries: () => [{ name: 'test', entry }], instance: () => ({ client: {} as any }), save: (_name, next) => { entry = next; } });
    expect(panel.panels?.find(panel => panel.id === MODEL_SETTINGS_PANEL)?.getMethods).toEqual(['input-capabilities']);
    const mimes = ['image/png', 'image/gif', 'audio/wav', 'video/mp4', 'application/pdf', 'application/octet-stream'];
    const query = () => panel.invoke!(MODEL_SETTINGS_PANEL, 'input-capabilities', [{ name: 'test', mimes }]) as Promise<any>;
    const before = structuredClone(entry);
    let result = await query();
    expect(entry).toEqual(before);
    expect(result.accepts).toEqual({ 'image/png': true, 'image/gif': false, 'audio/wav': true, 'video/mp4': true, 'application/pdf': true, 'application/octet-stream': false });
    expect(result).not.toHaveProperty('definitions');
    for (const mime of mimes) expect(result.accepts[mime]).toBe(OPENCODE.accepts(entry, entry.spec, mime));
    await panel.invoke!(MODEL_SETTINGS_PANEL, 'input-save', [{ name: 'test', model: entry.spec.model, kind: 'image', enabled: false }]);
    result = await query();
    expect(entry.multimodal).toBe(false);
    expect(result.accepts['image/png']).toBe(false);
    expect(result.accepts['audio/wav']).toBe(true);
    entry.options.protocol = 'chat';
    result = await query();
    expect(result.input).toContain('audio/wav');
    expect(result.accepts['audio/wav']).toBe(false);
    expect(result.accepts['video/mp4']).toBe(false);
    expect(result.accepts['application/pdf']).toBe(true);
    entry.options.attachments = 'off';
    expect(Object.values((await query()).accepts).every(value => value === false)).toBe(true);
    await expect(panel.invoke!(MODEL_SETTINGS_PANEL, 'input-capabilities', [{ name: 'test', mimes: ['audio'] }])).rejects.toThrow('Invalid MIME');
    await expect(panel.invoke!(MODEL_SETTINGS_PANEL, 'input-capabilities', [{ name: 'test', mimes: Array(129).fill('image/png') }])).rejects.toThrow('Invalid MIME');
  });
});

describe('reported billable meters', () => {
  function generation(native: any, rules: any[]): Generation {
    const quote = { id: 'fixture', capturedAt: '2026-11-17T00:00:00Z', source: 'fixture', currency: 'USD', basis: 'marginal' as const, rules };
    const meters = { ...unknownMeters(), native };
    return { attempts: [{ meters, charges: priceUsage(meters, [quote]), serviceTier: null }] } as Generation;
  }
  it('prices reported cache writes separately while retaining the billed input split', () => {
    const result = generation({ opencode: { tokens: { input: 10, output: 2, cache_read: 20, cache_write_5m: 3, cache_write_1h: 4 } } }, [
      { meter: 'uncachedInput', perMillion: 1 }, { meter: 'detail:cache_write', perMillion: 2 },
    ]);
    applyGatewayMeters(result);
    expect(result.attempts[0].meters.input).toBe(37);
    expect(result.attempts[0].meters.details?.cache_write.quantity).toBe(7);
    expect(result.attempts[0].charges[0].amount).toBeCloseTo(24 / 1e6);
  });
  it('does not make text-only requests unknown because an audio rate exists', () => {
    const result = generation({ prompt_tokens: 1 }, [{ meter: 'detail:audio_input', perMillion: 2 }]);
    applyGatewayMeters(result);
    expect(result.attempts[0].charges[0].amount).toBe(0);
    const audio = generation({}, [{ meter: 'detail:audio_input', perMillion: 2 }]);
    applyGatewayMeters(audio, new Set(['audio']));
    expect(audio.attempts[0].charges[0].amount).toBeNull();
  });

  it('does not guess the duration of positive cache writes and prices a proven zero correctly', () => {
    const rules = [{ meter: 'detail:cache_write_30m', perMillion: 2.5 }];
    const noWrites = generation({ opencode: { tokens: { cache_write_5m: 0, cache_write_1h: 0 } } }, rules);
    applyGatewayMeters(noWrites);
    expect(noWrites.attempts[0].charges[0].amount).toBe(0);
    const ambiguous = generation({ opencode: { tokens: { cache_write_5m: 3 } } }, rules);
    applyGatewayMeters(ambiguous);
    expect(ambiguous.attempts[0].charges[0].amount).toBeNull();
  });
});
