import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryMountProvider } from 'cortico/extensions/dry-mount.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { ProviderHost } from 'cortico/providers/base.ts';
import type { ProviderWebUiHost } from 'cortico/providers/webui/types.ts';
import OPENCODE, { BILLING_OPTIONS, DEFAULT_BILLING, billingOf, protocolOf } from '../src/index.ts';
import { DEFAULT_PROTOCOL } from '../src/options.ts';
import { baseUrlOf, familyOf, modelListUrl, parseGateway, PROTOCOLS, usageUrl } from '../src/address.ts';
import { modelsUrl } from '../src/catalog.ts';
import { USER_AGENT } from '../src/identity.ts';
import { GO_ROWS, CONSOLE_ROWS, monthlyLimit, prices, WINDOW_SHARE } from '../src/pricing.ts';
import { advancePercent, parseUsage } from '../src/usage.ts';
import { buildMessagesBody, MessagesAssembly } from '../src/anthropic.ts';
import { buildGeminiBody, GeminiAssembly, parseGeminiResponse } from '../src/gemini.ts';
import { opencodeWebUi, ALLOWANCE_PANEL } from '../src/webui/server.ts';
import { OpenCodeResponses, SpendLedger } from '../src/native.ts';
import { createCatalog, pickFacts } from '../src/catalog.ts';
import { readUsage } from '../src/usage.ts';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'opencode-provider-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

const entry = (overrides: Partial<LLMProviderEntry> = {}): LLMProviderEntry => ({
  kind: 'opencode',
  baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  secret: 'OPENCODE_KEY',
  ...overrides,
});

const host = (): ProviderHost => ({
  stateDir: scratchDir,
  secret: () => 'test-key',
  readBlob: () => null,
  keepThinking: () => true,
  log: { debug() {}, info() {}, warn() {}, error() {} },
} as unknown as ProviderHost);

describe('OpenCode provider', () => {
  it('dry mount reports no failures: the loader accepts it', () => {
    expect(dryMountProvider(OPENCODE, { scratchDir }).failures).toEqual([]);
  });

  it('declares the three dialects it speaks and the one account it needs', () => {
    expect(OPENCODE.describe?.protocols).toEqual(['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini']);
    expect(OPENCODE.describe?.auth).toEqual(['api-key']);
    expect(OPENCODE.describe?.local).toBe(false);
  });

  it('starts a new endpoint on a Go subscription over Chat, the native path for most models', () => {
    expect(DEFAULT_BILLING).toBe('go');
    expect(DEFAULT_PROTOCOL).toBe('chat');
    expect(protocolOf(entry())).toBe('chat');
    expect(billingOf(entry())).toBe('go');
    expect(OPENCODE.defaultBaseUrl).toBe('https://opencode.ai/inference/go/openai/v1');
  });

  it('rejects a protocol or account outside the declared values', () => {
    expect(() => OPENCODE.validateEntry?.(entry({ options: { protocol: 'grpc' } }), 'en')).toThrow(/responses \/ chat \/ anthropic \/ gemini/);
    expect(() => OPENCODE.validateEntry?.(entry({ options: { billing: 'auto' } }), 'en')).toThrow(/go \/ balance/);
    expect(() => OPENCODE.validateEntry?.(entry({ options: { protocol: 'anthropic', billing: 'balance' } }), 'en')).not.toThrow();
  });

  it('drops an option left empty rather than failing on it', () => {
    expect(OPENCODE.normalize?.(entry({ options: { protocol: '', billing: '' } })).options).toEqual({});
  });

  it('offers the four thinking levels, with the effort strings the gateway takes', () => {
    expect(OPENCODE.reasoningTiers.map((tier) => [tier.id, tier.thinking, tier.effort ?? null])).toEqual([
      ['off', false, null],
      ['low', true, 'low'],
      ['medium', true, 'medium'],
      ['high', true, 'high'],
    ]);
  });

  it('keeps the output cap below a small context window so the endpoint still validates', () => {
    const small = OPENCODE.normalize?.(entry({ spec: { model: 'tiny', thinking: false, contextWindow: 4000 } }));
    expect(small?.spec?.maxTokens).toBe(2000);
    expect(() => OPENCODE.validateEntry?.(small!, 'en')).not.toThrow();
  });

  it('fills the temperature and output cap a picked model starts with', () => {
    const filled = OPENCODE.normalize?.(entry({ spec: { model: 'glm-5.3', thinking: false } }));
    expect(filled?.spec?.temperature).toBe(1);
    expect(filled?.spec?.maxTokens).toBe(8192);
    // An operator's own values are kept.
    const kept = OPENCODE.normalize?.(entry({ spec: { model: 'glm-5.3', thinking: false, temperature: 0.2, maxTokens: 2048 } }));
    expect(kept?.spec?.temperature).toBe(0.2);
    expect(kept?.spec?.maxTokens).toBe(2048);
  });
});

describe('gateway address', () => {
  it('reads the gateway root and ignores the family the URL happens to name', () => {
    expect(parseGateway('https://opencode.ai/inference/go/openai/v1')).toEqual({ root: 'https://opencode.ai/inference' });
    expect(parseGateway('https://opencode.ai/inference/anthropic/v1')).toEqual({ root: 'https://opencode.ai/inference' });
    expect(parseGateway('https://proxy.example.com/v1')).toBeNull();
  });

  it('takes the family from the protocol and the segment from the account', () => {
    const gateway = parseGateway('https://opencode.ai/inference/go/openai/v1')!;
    expect(familyOf('responses')).toBe('openai/v1');
    expect(familyOf('chat')).toBe('openai/v1');
    expect(familyOf('anthropic')).toBe('anthropic/v1');
    expect(baseUrlOf(gateway, 'go', 'responses')).toBe('https://opencode.ai/inference/go/openai/v1');
    expect(baseUrlOf(gateway, 'balance', 'responses')).toBe('https://opencode.ai/inference/openai/v1');
    expect(baseUrlOf(gateway, 'go', 'anthropic')).toBe('https://opencode.ai/inference/go/anthropic/v1');
  });

  it('asks the gateway root for the model list and the Go usage windows', () => {
    const gateway = parseGateway('https://opencode.ai/inference/go/openai/v1')!;
    expect(modelListUrl(gateway, 'go')).toBe('https://opencode.ai/inference/go/v1/models');
    expect(modelListUrl(gateway, 'balance')).toBe('https://opencode.ai/inference/v1/models');
    expect(usageUrl(gateway)).toBe('https://opencode.ai/inference/go/v1/usage');
    expect(modelsUrl('https://proxy.example.com/v1/', 'go')).toBe('https://proxy.example.com/v1/models');
  });

  it('declares exactly three protocols and two accounts', () => {
    expect([...PROTOCOLS]).toEqual(['responses', 'chat', 'anthropic', 'gemini']);
    expect([...BILLING_OPTIONS]).toEqual(['go', 'balance']);
  });
});

describe('endpoint wiring', () => {
  it('offers a client, a control object and the model list', () => {
    const instance = OPENCODE.create('main', entry(), host());
    expect(instance.client).toBeDefined();
    expect(instance.control).toBeDefined();
    expect(typeof instance.listModels).toBe('function');
  });

  it('keys compatibility by endpoint, protocol and account', () => {
    const instance = OPENCODE.create('main', entry({ options: { protocol: 'chat', billing: 'balance' } }), host());
    expect(instance.compatibilityKey?.()).toEqual(['main', 'chat', 'balance']);
  });

  it('identifies itself to the gateway', () => {
    expect(USER_AGENT).toMatch(/^cortico-provider-opencode\//);
  });
});

describe('prices', () => {
  const at = '2026-10-28T00:00:00.000Z';

  it('prices a balance request as money spent and a Go request as allowance consumed', () => {
    expect(prices('balance', at).every((definition) => definition.basis === 'marginal')).toBe(true);
    expect(prices('go', at).every((definition) => definition.basis === 'equivalent')).toBe(true);
  });

  it('keeps the two pages apart, because they list different models at different rates', () => {
    const consoleModels = new Set(CONSOLE_ROWS.map((row) => row.id));
    const goModels = new Set(GO_ROWS.map((row) => row.id));
    expect([...goModels].some((model) => !consoleModels.has(model))).toBe(true);
    expect(consoleModels.size).toBeGreaterThan(goModels.size);
  });

  it('states every rate in USD per model, and no model twice', () => {
    for (const billing of ['balance', 'go'] as const) {
      const definitions = prices(billing, at);
      expect(definitions.every((definition) => definition.currency === 'USD')).toBe(true);
      const models = definitions.flatMap((definition) => definition.models);
      expect(new Set(models).size).toBe(models.length);
      expect(definitions.every((definition) => definition.rules.length > 0)).toBe(true);
    }
  });

  it('moves a long prompt onto the band the page states', () => {
    const haiku = prices('go', at).find((definition) => definition.models.includes('claude-haiku-5-5'));
    expect(haiku?.inputBands?.[0]?.from).toBe(100_001);
  });

  it('bills Go DeepSeek at peak hours only, the rest of the week off-peak', () => {
    const deepseek = prices('go', at).find((definition) => definition.models.includes('deepseek-v4-pro'));
    expect(deepseek?.timeWindows?.map((window) => [window.from, window.to, window.timezone])).toEqual([
      ['01:00', '04:00', 'UTC'],
      ['06:00', '10:00', 'UTC'],
    ]);
  });

  it('applies a stated discount inside its window and the list price after it', () => {
    const rateAt = (date: string) => prices('balance', date)
      .find((definition) => definition.models.includes('gemini-4-argon'))
      ?.rules.find((rule) => rule.meter === 'uncachedInput')?.perMillion;
    expect(rateAt('2026-10-28T00:00:00.000Z')).toBe(2);
    expect(rateAt('2026-12-01T00:00:00.000Z')).toBe(4);
  });

  it('states the monthly allowance the Go page gives each model', () => {
    expect(monthlyLimit('claude-haiku-5-5')).toBe(15);
    expect(monthlyLimit('deepseek-v4.1-flash')).toBe(80);
    expect(monthlyLimit('not-a-model')).toBeNull();
  });
});

describe('allowance', () => {
  it('reads the three windows and their reset times', () => {
    const usage = parseUsage({
      usage: {
        rolling: { status: 'ok', percent: 12.5, resetsAt: '2026-10-28T05:00:00.000Z' },
        weekly: { status: 'ok', percent: 40, resetsAt: '2026-11-02T00:00:00.000Z' },
        monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-11-01T00:00:00.000Z' },
      },
    });
    expect(usage.rolling.percent).toBe(12.5);
    expect(usage.monthly.status).toBe('rate-limited');
  });

  it('refuses a window without a percentage or a reset time', () => {
    const window = { status: 'ok', percent: 10, resetsAt: '2026-10-28T05:00:00.000Z' };
    expect(() => parseUsage({ usage: { rolling: window, weekly: { ...window, percent: 'ten' }, monthly: window } })).toThrow(/percentage/);
    expect(() => parseUsage({ usage: { rolling: window, weekly: window, monthly: { ...window, resetsAt: 'soon' } } })).toThrow(/reset/);
    expect(() => parseUsage({})).toThrow(/usage object/);
  });

  it('turns local spend into a share of each window, using the model’s monthly allowance', () => {
    // $3 of a $15 monthly allowance is 100% of the 5-hour window, 40% of the week and 20% of the month.
    const spend = { 'claude-haiku-5-5': 3 };
    expect(WINDOW_SHARE).toEqual({ rolling: 0.2, weekly: 0.5, monthly: 1 });
    expect(advancePercent(spend, 'rolling')).toBeCloseTo(100, 6);
    expect(advancePercent(spend, 'weekly')).toBeCloseTo(40, 6);
    expect(advancePercent(spend, 'monthly')).toBeCloseTo(20, 6);
  });

  it('attributes nothing when no model in the ledger states an allowance', () => {
    expect(advancePercent({ 'not-a-model': 3 }, 'monthly')).toBeNull();
    expect(advancePercent({}, 'monthly')).toBeNull();
  });

  it('keeps the ledger per model and clears it after a read', () => {
    const ledger = new SpendLedger();
    ledger.add('glm-5.3', 0.25);
    ledger.add('glm-5.3', 0.25);
    ledger.add('kimi-k3', 1);
    expect(ledger.snapshot()).toEqual({ 'glm-5.3': 0.5, 'kimi-k3': 1 });
    ledger.clear();
    expect(ledger.snapshot()).toEqual({});
  });
});

describe('allowance panel', () => {
  const webUiHost = (entries: LLMProviderEntry[], control: unknown): ProviderWebUiHost => ({
    language: 'en',
    entries: () => entries.map((value, index) => ({ name: index === 0 ? 'main' : `other${index}`, entry: value })),
    instance: () => ({ client: {} as never, control }),
    save: () => {},
  });

  it('lists the four connection blocks around its own section', () => {
    const panels = opencodeWebUi(webUiHost([entry()], {})).panels ?? [];
    expect(panels.map((panel) => panel.id)).toEqual(['endpoint', 'model', ALLOWANCE_PANEL, 'pricing', 'protocol']);
    expect(opencodeWebUi(webUiHost([entry()], {})).config).toEqual([]);
  });

  it('answers a local read without touching the gateway', async () => {
    const control = {
      read: async () => { throw new Error('network must not be reached'); },
      spend: () => ({ 'glm-5.3': 0.5 }),
      advance: (window: string) => (window === 'monthly' ? 1.5 : null),
    };
    const contribution = opencodeWebUi(webUiHost([entry()], control));
    const state = await contribution.invoke?.(ALLOWANCE_PANEL, 'local', [{ name: 'main' }]);
    expect(state).toEqual({ spend: { 'glm-5.3': 0.5 }, advance: { rolling: null, weekly: null, monthly: 1.5 } });
  });

  it('refuses a balance endpoint instead of drawing empty bars', async () => {
    const contribution = opencodeWebUi(webUiHost([entry({ options: { billing: 'balance' } })], {}));
    await expect(contribution.invoke?.(ALLOWANCE_PANEL, 'read', [{ name: 'main' }])).rejects.toThrow(/balance/);
  });

  it('refuses an address that is not an OpenCode gateway', async () => {
    const contribution = opencodeWebUi(webUiHost([entry({ baseUrl: 'https://proxy.example.com/v1' })], {}));
    await expect(contribution.invoke?.(ALLOWANCE_PANEL, 'read', [{ name: 'main' }])).rejects.toThrow(/gateway/);
  });

  it('refuses a method it does not have', async () => {
    const contribution = opencodeWebUi(webUiHost([entry()], {}));
    await expect(contribution.invoke?.(ALLOWANCE_PANEL, 'reset', [{ name: 'main' }])).rejects.toThrow(/reset/);
  });
});

describe('Messages dialect', () => {
  const request = {
    model: 'claude-sonnet-5-5',
    instructions: 'be brief',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
  } as never;
  const options = { nativeSpec: { model: 'claude-sonnet-5-5', thinking: false, maxTokens: 256 } } as never;

  it('sends instructions as the system prompt and states a max_tokens', () => {
    const body = buildMessagesBody(request, options) as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.system).toBe('be brief');
    expect(body.max_tokens).toBe(256);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('defaults max_tokens when the endpoint states none', () => {
    const body = buildMessagesBody(request, { nativeSpec: { model: 'm', thinking: false } } as never) as Record<string, unknown>;
    expect(typeof body.max_tokens).toBe('number');
  });

  it('translates a text stream into items and meters', () => {
    const assembly = new MessagesAssembly(request);
    const events: unknown[] = [];
    const emit = (event: unknown): void => { events.push(event); };
    assembly.feed({ type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5-5' } }, emit as never);
    assembly.feed({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, emit as never);
    assembly.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }, emit as never);
    assembly.feed({ type: 'content_block_stop', index: 0 }, emit as never);
    assembly.feed({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 2 } }, emit as never);
    const response = assembly.finish(emit as never);
    expect(response.status).toBe('completed');
    const message = response.output.find((item) => item.type === 'message') as { content: Array<{ text: string }> } | undefined;
    expect(message?.content[0].text).toBe('hello');
    expect(assembly.meters().output).toBe(2);
    expect(events.length).toBeGreaterThan(0);
  });

  it('closes a tool call with its complete arguments', () => {
    const assembly = new MessagesAssembly(request);
    const emit = (): void => {};
    assembly.feed({ type: 'message_start', message: { id: 'msg_2', model: 'm' } }, emit as never);
    assembly.feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo' } }, emit as never);
    assembly.feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }, emit as never);
    assembly.feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } }, emit as never);
    assembly.feed({ type: 'content_block_stop', index: 0 }, emit as never);
    assembly.feed({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 5, output_tokens: 3 } }, emit as never);
    const response = assembly.finish(emit as never);
    const call = response.output.find((item) => item.type === 'function_call') as { name: string; arguments: string } | undefined;
    expect(call?.name).toBe('echo');
    expect(JSON.parse(call!.arguments)).toEqual({ a: 1 });
  });
});

describe('Gemini dialect', () => {
  const request = {
    model: 'gemini-3-flash',
    instructions: 'be brief',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  } as never;

  it('takes its own family path, with the model and the method in the request path', () => {
    const gateway = parseGateway('https://opencode.ai/inference/go/openai/v1')!;
    expect(familyOf('gemini')).toBe('google/v1beta');
    expect(baseUrlOf(gateway, 'go', 'gemini')).toBe('https://opencode.ai/inference/go/google/v1beta');
    expect(baseUrlOf(gateway, 'balance', 'gemini')).toBe('https://opencode.ai/inference/google/v1beta');
  });

  it('sends contents, a system instruction and a token limit', () => {
    const body = buildGeminiBody(request, { nativeSpec: { model: 'gemini-3-flash', thinking: false, maxTokens: 128 } } as never) as Record<string, any>;
    expect(body.systemInstruction.parts[0].text).toBe('be brief');
    expect(body.generationConfig.maxOutputTokens).toBe(128);
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0].text).toBe('hi');
  });

  it('names a tool result after the call it answers', () => {
    const withTool = {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'function_call', call_id: 'call_9', name: 'echo', arguments: '{"a":1}' },
        { type: 'function_call_output', call_id: 'call_9', output: 'done' },
      ],
    } as never;
    const body = buildGeminiBody(withTool, { nativeSpec: { model: 'm', thinking: false } } as never) as Record<string, any>;
    const model = body.contents.find((turn: any) => turn.role === 'model');
    expect(model.parts[0].functionCall).toEqual({ name: 'echo', args: { a: 1 } });
    const user = body.contents[body.contents.length - 1];
    expect(user.parts[0].functionResponse.name).toBe('echo');
  });

  it('translates a stream into text, thinking, a tool call and meters', () => {
    const assembly = new GeminiAssembly(request);
    const emit = (): void => {};
    assembly.feed({ candidates: [{ content: { parts: [{ text: 'hel' }] } }] }, emit as never);
    assembly.feed({ candidates: [{ content: { parts: [{ text: 'lo' }] } }] }, emit as never);
    assembly.feed({ candidates: [{ content: { parts: [{ text: 'why', thought: true }] } }] }, emit as never);
    assembly.feed({ candidates: [{ content: { parts: [{ functionCall: { name: 'echo', args: { a: 1 } } }] } }] }, emit as never);
    assembly.feed({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 } }, emit as never);
    const response = assembly.finish(emit as never);
    expect(response.status).toBe('completed');
    const message = response.output.find((item) => item.type === 'message') as any;
    expect(message.content[0].text).toBe('hello');
    const call = response.output.find((item) => item.type === 'function_call') as any;
    expect(call.name).toBe('echo');
    expect(assembly.meters().output).toBe(4);
  });

  it('closes a stream that ended without a finish reason', () => {
    const assembly = new GeminiAssembly(request);
    const emit = (): void => {};
    assembly.feed({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }, emit as never);
    const response = assembly.finish(emit as never);
    expect(response.status).toBe('completed');
  });

  it('maps a token-limit stop to an incomplete response', () => {
    const assembly = new GeminiAssembly(request);
    const emit = (): void => {};
    assembly.feed({ candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] }, emit as never);
    const response = assembly.finish(emit as never);
    expect(response.status).toBe('incomplete');
    expect(response.incomplete_details?.reason).toBe('max_output_tokens');
  });

  it('reads a whole response the same way as a stream', () => {
    const parsed = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'hi there' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    }, request);
    expect(parsed.response.status).toBe('completed');
    expect(parsed.meters.output).toBe(2);
  });
});
describe('the fixes the first field test needed', () => {
  it('drops an empty model so the list can be fetched before a model is picked', () => {
    const empty = entry({ spec: { model: '', thinking: false } as never });
    expect(OPENCODE.normalize?.(empty).spec).toBeUndefined();
    const picked = entry({ spec: { model: 'glm-5.3', thinking: false } });
    expect(OPENCODE.normalize?.(picked).spec?.model).toBe('glm-5.3');
  });

  it('accepts an endpoint with no model at all', () => {
    expect(() => OPENCODE.validateEntry?.(OPENCODE.normalize?.(entry()) ?? entry(), 'en')).not.toThrow();
  });

  it('always sends a session id, because the Go endpoints refuse a request without one', async () => {
    const seen: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      seen['x-opencode-session'] = req.headers['x-opencode-session'];
      seen['user-agent'] = req.headers['user-agent'];
      seen.authorization = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_1', model: 'm', output: [], status: 'completed' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const client = new OpenCodeResponses({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' });
      // The connectivity probe passes no sessionId; the header must still be there.
      await client.respond({ model: 'm', input: [] } as never, { diagnostic: true });
      expect(typeof seen['x-opencode-session']).toBe('string');
      expect(String(seen['x-opencode-session'])).not.toHaveLength(0);
      expect(seen['user-agent']).toBe(USER_AGENT);
      expect(seen.authorization).toBe('Bearer test-key');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports why the usage read failed instead of a bare status', async () => {
    const server = createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'this key has no Go subscription' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const gateway = { root: `http://127.0.0.1:${port}` };
      await expect(readUsage(gateway, 'test-key', 'session-1')).rejects.toThrow(/401.*no Go subscription/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reads facts for a model from the catalogue, OpenCode’s section first', () => {
    const catalog = {
      other: { models: { 'glm-5.3': { name: 'Wrong', limit: { context: 1, output: 1 } } } },
      opencode: { models: { 'glm-5.3': { name: 'GLM 5.3', limit: { context: 200_000, output: 8_192 }, modalities: { input: ['text', 'image'] } } } },
    };
    const facts = pickFacts(catalog, ['glm-5.3', 'missing']);
    expect(facts['glm-5.3']).toEqual({ name: 'GLM 5.3', context: 200_000, output: 8_192, images: true });
    expect(facts.missing).toBeUndefined();
  });
});
describe('catalogue cache timing', () => {
  it('answers a context window that another instance wrote after this one was built', async () => {
    const cacheFile = join(scratchDir, 'models.json');
    const before = createCatalog({ baseUrl: 'https://opencode.ai/inference/go/openai/v1', billing: 'go', cacheFile });
    // The endpoint editor asks this right after a list was fetched; here the list wrote the file later.
    expect(before.contextWindow('glm-5.3')).toBeUndefined();
    writeFileSync(cacheFile, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      models: { 'glm-5.3': { name: 'GLM 5.3', context: 1_000_000, output: 131_072, images: false } },
    }));
    expect(before.contextWindow('glm-5.3')).toBe(1_000_000);
  });
});
describe('usage authentication', () => {
  it('retries a rejected key with the other header and remembers the one that worked', async () => {
    let bearerTries = 0;
    let keyTries = 0;
    const server = createServer((req, res) => {
      const viaKey = typeof req.headers['x-api-key'] === 'string';
      if (viaKey) keyTries++; else bearerTries++;
      if (!viaKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'AuthError', message: 'Unauthorized' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        usage: {
          rolling: { status: 'ok', percent: 10, resetsAt: '2026-10-28T05:00:00.000Z' },
          weekly: { status: 'ok', percent: 20, resetsAt: '2026-11-02T00:00:00.000Z' },
          monthly: { status: 'ok', percent: 30, resetsAt: '2026-11-01T00:00:00.000Z' },
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const gateway = { root: `http://127.0.0.1:${port}` };
    try {
      const first = await readUsage(gateway, 'oc_sk_test_key', 'session-1');
      expect(first.rolling.percent).toBe(10);
      expect(bearerTries).toBe(1);
      expect(keyTries).toBe(1);
      // The accepted header is remembered, so the next read does not spend a request finding out.
      await readUsage(gateway, 'oc_sk_test_key', 'session-1');
      expect(bearerTries).toBe(1);
      expect(keyTries).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
describe('allowance readiness', () => {
  const webUiHost = (entries: LLMProviderEntry[], control: unknown): ProviderWebUiHost => ({
    language: 'en',
    entries: () => entries.map((value) => ({ name: 'main', entry: value })),
    instance: () => ({ client: {} as never, control }),
    save: () => {},
  });

  it('says the key value is not saved instead of asking the gateway', async () => {
    const control = { hasKey: () => false, read: async () => { throw new Error('network must not be reached'); } };
    const contribution = opencodeWebUi(webUiHost([entry()], control));
    const state = await contribution.invoke?.(ALLOWANCE_PANEL, 'state', [{ name: 'main' }]);
    expect(state).toMatchObject({ ready: false });
    expect(String((state as { reason: string }).reason)).toMatch(/key value/i);
  });

  it('says the endpoint is unsaved when the page is a draft', async () => {
    const control = { hasKey: () => true, read: async () => ({}) };
    const contribution = opencodeWebUi({ ...webUiHost([entry()], control), editing: true });
    const state = await contribution.invoke?.(ALLOWANCE_PANEL, 'state', [{ name: 'main' }]);
    expect(String((state as { reason: string }).reason)).toMatch(/not saved/i);
  });

  it('names a missing secret variable separately from a missing value', async () => {
    const control = { hasKey: () => false, read: async () => ({}) };
    const contribution = opencodeWebUi(webUiHost([entry({ secret: undefined })], control));
    const state = await contribution.invoke?.(ALLOWANCE_PANEL, 'state', [{ name: 'main' }]);
    expect(String((state as { reason: string }).reason)).toMatch(/variable name/i);
  });

  it('is ready once the key is there', async () => {
    const control = { hasKey: () => true, read: async () => ({}) };
    const contribution = opencodeWebUi(webUiHost([entry()], control));
    expect(await contribution.invoke?.(ALLOWANCE_PANEL, 'state', [{ name: 'main' }])).toEqual({ ready: true, reason: null });
  });

  it('is not ready on a balance endpoint or a foreign address', async () => {
    const control = { hasKey: () => true, read: async () => ({}) };
    const balance = opencodeWebUi(webUiHost([entry({ options: { billing: 'balance' } })], control));
    expect(await balance.invoke?.(ALLOWANCE_PANEL, 'state', [{ name: 'main' }])).toMatchObject({ ready: false });
    const foreign = opencodeWebUi(webUiHost([entry({ baseUrl: 'https://proxy.example.com/v1' })], control));
    expect(await foreign.invoke?.(ALLOWANCE_PANEL, 'state', [{ name: 'main' }])).toMatchObject({ ready: false });
  });
});