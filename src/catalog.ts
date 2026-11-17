/**
 * The live model list, and what the model catalogue states about each entry.
 *
 * Gateway declarations supply exact input MIME types, context limits and prices. Missing facts can
 * be supplemented from the account's models.dev section. Matched facts are cached for a day under
 * the endpoint directory; every explicit model-list read refreshes gateway declarations.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { ListedModel } from 'cortico/providers/base.ts';
import { modelListUrl, parseGateway } from './address.ts';
import { identityHeaders } from './identity.ts';
import { auxiliarySignal, parseJsonText, readLimitedText } from './http.ts';
import type { Billing } from './pricing.ts';

import snapshot from './models-snapshot.json' with { type: 'json' };
import { factsOf, type ModelFacts } from './model-metadata.ts';
export type { ModelFacts } from './model-metadata.ts';

export interface CatalogOptions {
  baseUrl: string;
  billing: Billing;
  /** Where the matched subset is cached, inside the endpoint directory. */
  cacheFile: string;
  /**
   * The key for the list request. The gateway filters this listing by account: without a key it
   * answers with the whole catalog, which offers models the account cannot call.
   */
  apiKey?: () => string | undefined;
}

export interface Catalog {
  listModels(): Promise<ListedModel[]>;
  /** Answers from what is already known; the editor calls this after a list has been fetched. */
  contextWindow(model: string): number | undefined;
  facts(model: string): ModelFacts | undefined;
}

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const MODEL_LIST_MAX_BYTES = 2 * 1024 * 1024;

export function modelsUrl(baseUrl: string, billing: Billing): string {
  const gateway = parseGateway(baseUrl);
  return gateway ? modelListUrl(gateway, billing) : `${baseUrl.replace(/\/+$/, '')}/models`;
}

async function gatewayRows(opts: CatalogOptions): Promise<Record<string, any>[]> {
  const key = opts.apiKey?.();
  const response = await fetch(modelsUrl(opts.baseUrl, opts.billing), {
    signal: auxiliarySignal(),
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...identityHeaders(''),
    },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`OpenCode model list: HTTP ${response.status}`);
  }
  const body = parseJsonText(await readLimitedText(response, MODEL_LIST_MAX_BYTES, 'OpenCode model list'), 'OpenCode model list') as { data?: unknown[] } | null;
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.flatMap((row) => {
    const id = row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id ? [row as Record<string, any>] : [];
  });
}

/** The facts for the ids asked about: OpenCode's own section first, then any other that lists the id. */
export function pickFacts(catalog: Record<string, any>, ids: readonly string[], billing: Billing = 'balance'): Record<string, ModelFacts> {
  const wanted = new Set(ids);
  const found: Record<string, ModelFacts> = Object.create(null);
  const sections = [billing === 'go' ? catalog['opencode-go'] : catalog.opencode, catalog.opencode, ...Object.values(catalog)].filter(
    (section): section is Record<string, any> => Boolean(section) && typeof section === 'object' && Boolean(section.models),
  );
  for (const section of sections) {
    for (const id of wanted) {
      if (found[id]) continue;
      const raw = Object.hasOwn(section.models, id) ? section.models[id] : undefined;
      if (raw && typeof raw === 'object') found[id] = factsOf(raw);
    }
  }
  return found;
}

function readCache(file: string, scope?: string): { fetchedAt: string; models: Record<string, ModelFacts> } | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt?: unknown; models?: unknown };
    if (typeof raw.fetchedAt !== 'string' || !raw.models || typeof raw.models !== 'object') return null;
    if (!Number.isFinite(Date.parse(raw.fetchedAt)) || Date.now() - Date.parse(raw.fetchedAt) > CACHE_TTL_MS) return null;
    if (scope && (raw as { scope?: string }).scope && (raw as { scope?: string }).scope !== scope) return null;
    return { fetchedAt: raw.fetchedAt, models: raw.models as Record<string, ModelFacts> };
  } catch {
    return null;
  }
}

async function fetchFacts(ids: readonly string[], billing: Billing): Promise<Record<string, ModelFacts>> {
  const response = await fetch(CATALOG_URL, {
    headers: { Accept: 'application/json' }, signal: auxiliarySignal(), redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`models.dev: HTTP ${response.status}`);
  }
  const text = await readLimitedText(response, MAX_BYTES, 'models.dev');
  return pickFacts(parseJsonText(text, 'models.dev') as Record<string, any>, ids, billing);
}

/**
 * The facts one endpoint has learned, shared by cache file so an instance built before the list was
 * fetched still answers afterwards.
 */
const byEndpoint = new Map<string, Record<string, ModelFacts>>();
export function knownFacts(baseUrl: string, billing: Billing, model: string): ModelFacts | undefined {
  const known = byEndpoint.get(`${baseUrl.replace(/\/+$/, '')}|${billing}`)?.[model];
  const account = snapshot[billing] as Record<string, any>;
  const fallback = parseGateway(baseUrl) && Object.hasOwn(account, model) ? factsOf(account[model]) : undefined;
  return known ? { ...fallback, ...known } : fallback;
}

const shared = new Map<string, Record<string, ModelFacts>>();

function load(file: string, scope: string): Record<string, ModelFacts> {
  const key = `${file}|${scope}`;
  const known = shared.get(key);
  if (known) return known;
  // Model ids are external dictionary keys, including names such as `constructor` or `__proto__`.
  // A null prototype also makes later Object.assign cache merges ordinary data writes.
  const fromDisk: Record<string, ModelFacts> = Object.assign(Object.create(null), readCache(file, scope)?.models);
  shared.set(key, fromDisk);
  return fromDisk;
}

export function createCatalog(opts: CatalogOptions): Catalog {
  const scope = `${opts.baseUrl.replace(/\/+$/, '')}|${opts.billing}`;
  const known = load(opts.cacheFile, scope);
  byEndpoint.set(`${opts.baseUrl.replace(/\/+$/, '')}|${opts.billing}`, known);

  return {
    async listModels(): Promise<ListedModel[]> {
      const rows = await gatewayRows(opts);
      const ids = rows.map(row => row.id as string);
      try {
        if (rows.some(row => {
          const incoming = factsOf(row);
          return (['input', 'context', 'output', 'name', 'cost'] as const).some(key => incoming[key] === undefined && known[row.id]?.[key] === undefined);
        })) {
          Object.assign(known, await fetchFacts(ids, opts.billing));
        }
      } catch {
        // the gateway's ids are still a usable list; the fields it cannot state stay absent
      }
      for (const row of rows) known[row.id] = { ...known[row.id], ...factsOf(row) };
      if (Object.values(known).some(facts => Object.keys(facts).length)) {
        try { writeFileSync(opts.cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), scope, models: known }, null, 2)); } catch { /* Cache is optional. */ }
      }
      return ids.map((id) => {
        const facts = known[id];
        return {
          id,
          ...(facts?.name ? { displayName: facts.name } : {}),
          ...(facts?.context ? { contextWindow: facts.context } : {}),
          ...(facts?.output ? { maxOutputTokens: facts.output } : {}),
          ...(facts?.images === undefined ? {} : { inputImages: facts.images }),
        };
      });
    },
    facts(model: string) {
      Object.assign(known, readCache(opts.cacheFile, scope)?.models);
      const merged = knownFacts(opts.baseUrl, opts.billing, model);
      return known[model] ? { ...merged, ...known[model] } : merged;
    },
    contextWindow(model: string): number | undefined {
      // The endpoint editor asks this right after a list was fetched, which may have happened after
      // this instance was built, so a miss re-reads what the list wrote.
      if (known[model]?.context === undefined) {
        const fromDisk = readCache(opts.cacheFile, scope)?.models;
        if (fromDisk) Object.assign(known, fromDisk);
      }
      return known[model]?.context;
    },
  };
}
