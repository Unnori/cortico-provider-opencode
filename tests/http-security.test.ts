import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalog, pickFacts } from '../src/catalog.ts';
import { auxiliarySignal, AUXILIARY_TIMEOUT_MS, readLimitedText } from '../src/http.ts';
import { readUsage } from '../src/usage.ts';

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bounded auxiliary response bodies', () => {
  it('counts bytes rather than UTF-16 characters and cancels an oversized stream', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('💡')); },
      cancel() { cancelled = true; },
    }));
    await expect(readLimitedText(response, 3, 'test')).rejects.toThrow('response too large');
    expect(cancelled).toBe(true);
  });

  it('preserves a UTF-8 character split across chunks', async () => {
    const bytes = Buffer.from('💡');
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 2));
        controller.enqueue(bytes.subarray(2));
        controller.close();
      },
    }));
    await expect(readLimitedText(response, 4, 'test')).resolves.toBe('💡');
  });

  it('cancels a response whose declared length already exceeds the limit', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
      headers: { 'Content-Length': '100' },
    });
    await expect(readLimitedText(response, 10, 'test')).rejects.toThrow('response too large');
    expect(cancelled).toBe(true);
  });

  it.each([200, 401])('bounds usage bodies even for HTTP %i', async (status) => {
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { status })));
    await expect(readUsage({ root: 'https://usage-size.test/inference' }, 'test-key', 'session'))
      .rejects.toThrow('response too large');
    expect(cancelled).toBe(true);
  });

  it('rejects an oversized model list before buffering the complete response', async () => {
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }))));
    const catalog = createCatalog({ baseUrl: 'https://models-size.test', billing: 'go', cacheFile: 'unused-size-cache.json' });
    await expect(catalog.listModels()).rejects.toThrow('response too large');
    expect(cancelled).toBe(true);
  });

  it('cancels an oversized facts response while preserving the gateway model ids', async () => {
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
        headers: { 'Content-Length': String(32 * 1024 * 1024 + 1) },
      });
    }));
    const catalog = createCatalog({ baseUrl: 'https://facts-size.test', billing: 'go', cacheFile: 'unused-facts-cache.json' });
    await expect(catalog.listModels()).resolves.toEqual([{ id: 'test-model' }]);
    expect(cancelled).toBe(true);
  });
});

describe('auxiliary request deadlines', () => {
  it('keeps both caller cancellation and a fixed deadline', () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const caller = new AbortController();
    const signal = auxiliarySignal(caller.signal);
    expect(timeout).toHaveBeenCalledWith(AUXILIARY_TIMEOUT_MS);
    caller.abort(new Error('cancelled by caller'));
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toBe('cancelled by caller');
    const next = auxiliarySignal(new AbortController().signal);
    deadline.abort(new Error('deadline'));
    expect(next.aborted).toBe(true);
  });

  it.each(['usage', 'models'])('aborts a %s body that never finishes', async (kind) => {
    const timeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(100));
    const source = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
    });
    try {
      const operation = kind === 'usage'
        ? readUsage({ root: source.url }, 'test-key', 'session')
        : createCatalog({ baseUrl: source.url, billing: 'go', cacheFile: 'unused-deadline-cache.json' }).listModels();
      await expect(operation).rejects.toThrow(/abort|timeout/i);
    } finally {
      await close(source.server);
    }
  });
});

describe('credential handling for auxiliary requests', () => {
  it.each(['bearer', 'x-api-key'])('refuses redirects while using %s authentication', async (variant) => {
    let leakedRequests = 0;
    const target = await listen((_req, res) => { leakedRequests++; res.end('{}'); });
    let requests = 0;
    const source = await listen((req, res) => {
      requests++;
      if (variant === 'x-api-key' && !req.headers['x-api-key']) {
        res.writeHead(401);
        res.end('try another header');
        return;
      }
      res.writeHead(307, { Location: `${target.url}/stolen` });
      res.end();
    });
    try {
      await expect(readUsage({ root: source.url }, 'private-test-key', 'session')).rejects.toThrow();
      expect(requests).toBe(variant === 'bearer' ? 1 : 2);
      expect(leakedRequests).toBe(0);
    } finally {
      await close(source.server);
      await close(target.server);
    }
  });

  it('refuses redirects from an authenticated model list', async () => {
    let leakedRequests = 0;
    const target = await listen((_req, res) => { leakedRequests++; res.end('{}'); });
    const source = await listen((_req, res) => {
      res.writeHead(302, { Location: `${target.url}/stolen` });
      res.end();
    });
    const cacheDir = mkdtempSync(join(tmpdir(), 'opencode-security-'));
    try {
      const catalog = createCatalog({
        baseUrl: source.url, billing: 'go', cacheFile: join(cacheDir, 'models.json'), apiKey: () => 'private-test-key',
      });
      await expect(catalog.listModels()).rejects.toThrow();
      expect(leakedRequests).toBe(0);
    } finally {
      await close(source.server);
      await close(target.server);
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('redacts a reflected key before truncating a diagnostic while retaining the reason', async () => {
    const key = 'private-key-that-must-not-appear';
    const source = await listen((_req, res) => {
      res.writeHead(403);
      res.end(`No Go subscription: ${'x'.repeat(170)}${key}`);
    });
    try {
      const error = await readUsage({ root: source.url }, key, 'session').catch((reason: Error) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('No Go subscription');
      expect(String(error)).toContain('[redacted]');
      expect(String(error)).not.toContain('private-key');
    } finally {
      await close(source.server);
    }
  });

  it.each(['usage', 'models'])('does not expose a reflected key in a %s JSON parser error', async (kind) => {
    const key = 'private-test-key-for-json-error';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`refused ${key}`)));
    const operation = kind === 'usage'
      ? readUsage({ root: 'https://json-error.test' }, key, 'session')
      : createCatalog({ baseUrl: 'https://json-error.test', billing: 'go', cacheFile: 'unused-json-cache.json', apiKey: () => key }).listModels();
    const error = await operation.catch((reason: Error) => reason);
    expect(String(error)).toContain('invalid JSON response');
    expect(String(error)).not.toContain(key);
  });
});

describe('model ids are dictionary keys', () => {
  it('accepts model ids that are also JavaScript prototype property names', () => {
    const catalog = { opencode: { models: {
      ['__proto__']: { name: 'Proto', limit: { context: 100 } },
      constructor: { name: 'Constructor', limit: { context: 200 } },
      toString: { name: 'String', limit: { context: 300 } },
    } } };
    const facts = pickFacts(catalog, ['__proto__', 'constructor', 'toString']);
    expect(facts.__proto__).toEqual({ name: 'Proto', context: 100 });
    expect(facts.constructor).toEqual({ name: 'Constructor', context: 200 });
    expect(facts.toString).toEqual({ name: 'String', context: 300 });
    expect(Object.getPrototypeOf(facts)).toBeNull();
  });

  it('does not inherit unlisted model facts during a cache merge', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'opencode-cache-security-'));
    const cacheFile = join(cacheDir, 'models.json');
    try {
      const catalog = createCatalog({ baseUrl: 'https://cache.test', billing: 'go', cacheFile });
      expect(catalog.contextWindow('intruder')).toBeUndefined();
      writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date().toISOString(),
        models: JSON.parse('{"__proto__":{"intruder":{"context":1234},"context":100}}'),
      }));
      expect(catalog.contextWindow('intruder')).toBeUndefined();
      expect(catalog.contextWindow('__proto__')).toBe(100);
      expect(catalog.contextWindow('constructor')).toBeUndefined();
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
