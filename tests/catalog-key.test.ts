import { describe, expect, it } from 'vitest';
import { createCatalog } from '../src/catalog.ts';

const cacheFile = 'scratch/catalog-key-test.json';

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** Replace fetch for one test and record the requests the catalog makes. */
function stubFetch(body: unknown, ok = true): { seen: Seen[]; restore: () => void } {
  const seen: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return {
        ok,
        status: ok ? 200 : 401,
        json: async () => (ok ? body : {}),
        text: async () => (ok ? JSON.stringify(body) : ''),
      } as unknown as Response;
    }
    // The models.dev lookup only adds context and price facts; an empty catalog leaves the ids as sent.
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

describe('the model list request carries the account key', () => {
  it('sends Authorization, because the gateway filters the catalog by account', async () => {
    // Without the header the gateway answers with the whole catalog, which offers models the account
    // cannot call; with it, the list is what the account may use.
    const stub = stubFetch({ data: [{ id: 'a' }, { id: 'b' }] });
    try {
      const catalog = createCatalog({
        baseUrl: 'https://opencode.ai/inference/openai/v1',
        billing: 'balance',
        cacheFile,
        apiKey: () => 'sk-test-123',
      });
      const models = await catalog.listModels();
      expect(models.map((model) => model.id)).toEqual(['a', 'b']);
      expect(stub.seen[0]?.url).toBe('https://opencode.ai/inference/v1/models');
      expect(stub.seen[0]?.headers.Authorization).toBe('Bearer sk-test-123');
    } finally {
      stub.restore();
    }
  });

  it('reads the key per request, so one saved after the instance still applies', async () => {
    const holder: { key: string | undefined } = { key: undefined };
    const stub = stubFetch({ data: [{ id: 'a' }] });
    try {
      const catalog = createCatalog({
        baseUrl: 'https://opencode.ai/inference/openai/v1',
        billing: 'balance',
        cacheFile,
        apiKey: () => holder.key,
      });
      await catalog.listModels();
      holder.key = 'sk-later';
      await catalog.listModels();
      expect(stub.seen).toHaveLength(2);
      expect(stub.seen[0]?.headers.Authorization).toBeUndefined();
      expect(stub.seen[1]?.headers.Authorization).toBe('Bearer sk-later');
    } finally {
      stub.restore();
    }
  });

  it('reports a refusal instead of guessing a list', async () => {
    const stub = stubFetch({}, false);
    try {
      const catalog = createCatalog({
        baseUrl: 'https://opencode.ai/inference/v1/models',
        billing: 'balance',
        cacheFile,
        apiKey: () => 'sk-test',
      });
      await expect(catalog.listModels()).rejects.toThrow(/model list/i);
    } finally {
      stub.restore();
    }
  });
});
