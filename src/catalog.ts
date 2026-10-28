/**
 * The live model list, and what the model catalogue states about each entry.
 *
 * The gateway answers `GET <root>/v1/models` with ids only. `https://models.dev/api.json` is the
 * catalogue OpenCode itself reads, and it states each model's context window, largest output and
 * whether it takes images — the fields the endpoint editor fills in when a model is picked. That file
 * is about 6 MB, so only the matched subset is kept, in the endpoint's own directory, and re-read once
 * a day. A failed read leaves the ids as the gateway gave them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { ListedModel } from 'cortico/providers/base.ts';
import { modelListUrl, parseGateway } from './address.ts';
import type { Billing } from './pricing.ts';

/** What the catalogue states about one model. */
export interface ModelFacts {
  name?: string;
  context?: number;
  output?: number;
  images?: boolean;
}

export interface CatalogOptions {
  baseUrl: string;
  billing: Billing;
  /** Where the matched subset is cached, inside the endpoint directory. */
  cacheFile: string;
}

export interface Catalog {
  listModels(): Promise<ListedModel[]>;
  /** Answers from what is already known; the editor calls this after a list has been fetched. */
  contextWindow(model: string): number | undefined;
}

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_MS = 20_000;
const MAX_BYTES = 32 * 1024 * 1024;

export function modelsUrl(baseUrl: string, billing: Billing): string {
  const gateway = parseGateway(baseUrl);
  return gateway ? modelListUrl(gateway, billing) : `${baseUrl.replace(/\/+$/, '')}/models`;
}

async function gatewayIds(baseUrl: string, billing: Billing): Promise<string[]> {
  const response = await fetch(modelsUrl(baseUrl, billing), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`OpenCode model list: HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  const rows = Array.isArray(body.data) ? body.data : [];
  return rows.flatMap((row) => (typeof row.id === 'string' && row.id ? [row.id] : []));
}

function factsOf(raw: Record<string, any>): ModelFacts {
  const limit = raw.limit ?? {};
  const input = raw.modalities?.input;
  const images = Array.isArray(input) ? input.includes('image') : raw.attachment === true ? true : undefined;
  return {
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
    ...(typeof limit.context === 'number' && limit.context > 0 ? { context: limit.context } : {}),
    ...(typeof limit.output === 'number' && limit.output > 0 ? { output: limit.output } : {}),
    ...(images === undefined ? {} : { images }),
  };
}

/** The facts for the ids asked about: OpenCode's own section first, then any other that lists the id. */
export function pickFacts(catalog: Record<string, any>, ids: readonly string[]): Record<string, ModelFacts> {
  const wanted = new Set(ids);
  const found: Record<string, ModelFacts> = {};
  const sections = [catalog.opencode, ...Object.values(catalog)].filter(
    (section): section is Record<string, any> => Boolean(section) && typeof section === 'object' && Boolean(section.models),
  );
  for (const section of sections) {
    for (const id of wanted) {
      if (found[id]) continue;
      const raw = section.models?.[id];
      if (raw && typeof raw === 'object') found[id] = factsOf(raw);
    }
  }
  return found;
}

function readCache(file: string): { fetchedAt: string; models: Record<string, ModelFacts> } | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt?: unknown; models?: unknown };
    if (typeof raw.fetchedAt !== 'string' || !raw.models || typeof raw.models !== 'object') return null;
    if (Date.now() - Date.parse(raw.fetchedAt) > CACHE_TTL_MS) return null;
    return { fetchedAt: raw.fetchedAt, models: raw.models as Record<string, ModelFacts> };
  } catch {
    return null;
  }
}

async function fetchFacts(ids: readonly string[]): Promise<Record<string, ModelFacts>> {
  const response = await fetch(CATALOG_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_MS) });
  if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('models.dev: response too large');
  return pickFacts(JSON.parse(text) as Record<string, any>, ids);
}

/**
 * The facts one endpoint has learned, shared by cache file so an instance built before the list was
 * fetched still answers afterwards.
 */
const shared = new Map<string, Record<string, ModelFacts>>();

function load(file: string): Record<string, ModelFacts> {
  const known = shared.get(file);
  if (known) return known;
  const fromDisk = readCache(file)?.models ?? {};
  shared.set(file, fromDisk);
  return fromDisk;
}

export function createCatalog(opts: CatalogOptions): Catalog {
  const known = load(opts.cacheFile);

  return {
    async listModels(): Promise<ListedModel[]> {
      const ids = await gatewayIds(opts.baseUrl, opts.billing);
      try {
        if (!Object.keys(known).length || ids.some((id) => !known[id])) {
          Object.assign(known, await fetchFacts(ids));
          writeFileSync(opts.cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), models: known }, null, 2));
        }
      } catch {
        // the gateway's ids are still a usable list; the fields it cannot state stay absent
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
    contextWindow(model: string): number | undefined {
      // The endpoint editor asks this right after a list was fetched, which may have happened after
      // this instance was built, so a miss re-reads what the list wrote.
      if (known[model]?.context === undefined) {
        const fromDisk = readCache(opts.cacheFile)?.models;
        if (fromDisk) Object.assign(known, fromDisk);
      }
      return known[model]?.context;
    },
  };
}
