/**
 * OpenCode as a Cortico provider. An endpoint is one OpenCode gateway endpoint: its base URL names the
 * gateway, `options.protocol` picks Responses, Chat Completions or Messages, and `options.billing` picks
 * the account — a Go subscription by default, or the Console balance. Console translates every text
 * model to the API it is asked on, so one endpoint reaches the whole catalogue.
 *
 * The model list comes from the gateway root, the prices from the page describing the account the
 * endpoint bills, and the allowance panel reads the Go windows the gateway reports. Nothing about a
 * model is hard-coded: an id is accepted whether or not the list mentions it.
 */
import { join } from 'node:path';
import type { ProviderModule, ProviderInstance } from 'cortico/providers/base.ts';
import type { ConfigGroup, LLMProviderEntry, ReasoningTier } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { isContextOverflow } from 'cortico/providers/transport/errors.ts';
import { baseUrlOf, parseGateway, PROTOCOLS, type Protocol } from './address.ts';
import { BILLING_OPTIONS, billingOf, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE, optionsOf, protocolOf } from './options.ts';
import { createCatalog } from './catalog.ts';
import { OpenCodeProvider, SpendLedger } from './native.ts';
import { prices, type Billing, type UsageWindow } from './pricing.ts';
import { advancePercent, readUsage, type UsageControl } from './usage.ts';
import { newSession } from './identity.ts';
import { opencodeText, type OpenCodeText } from './strings.ts';
import { opencodeWebUi } from './webui/server.ts';

export type { Protocol };
export { BILLING_OPTIONS, DEFAULT_BILLING, billingOf, protocolOf, type OpenCodeOptions } from './options.ts';

function optionsGroup(name: string, language: Language): ConfigGroup {
  const t = opencodeText(language);
  return {
    id: `llm.opencode.${name}`,
    owner: 'provider:opencode',
    schema: {
      type: 'object',
      title: t.title,
      properties: {
        [`providers.${name}.options.protocol`]: { type: 'string', enum: [...PROTOCOLS], title: t.protocol, description: t.protocolHint },
        [`providers.${name}.options.billing`]: { type: 'string', enum: [...BILLING_OPTIONS], title: t.billing, description: t.billingHint },
      },
    },
  };
}

/**
 * Two things the editor cannot state for a new endpoint are filled here. An endpoint whose model field
 * is still empty arrives as a spec with no name, which `validateEntry` refuses; dropping it is what lets
 * the model list be fetched before a model is picked. A picked model then gets the defaults OpenCode's
 * own examples use, so the endpoint is usable without hand-filling temperature and the output cap.
 */
function normalize(entry: LLMProviderEntry): LLMProviderEntry {
  const options: Record<string, unknown> = { ...entry.options };
  for (const key of ['protocol', 'billing']) if (options[key] === '') delete options[key];
  const spec = entry.spec;
  if (spec === undefined) return { ...entry, options };
  const model = (spec as { model?: unknown }).model;
  if (typeof model !== 'string' || !model.trim()) return { ...entry, options, spec: undefined };
  // `validateSpec` refuses an output cap at or above the context window, so a small model gets half its
  // window instead of the default; the operator can still raise it.
  const contextWindow = spec.contextWindow;
  const cap = spec.maxTokens
    ?? (contextWindow !== undefined && contextWindow <= DEFAULT_MAX_TOKENS
      ? Math.max(1, Math.floor(contextWindow / 2))
      : DEFAULT_MAX_TOKENS);
  return {
    ...entry,
    options,
    spec: {
      ...spec,
      temperature: spec.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: cap,
    },
  };
}

/** The thinking levels the endpoint offers; the effort strings are the ones the gateway takes. */
const tiers = (t: OpenCodeText): ReasoningTier[] => [
  { id: 'off', label: t.tierOff, thinking: false },
  { id: 'low', label: t.tierLow, thinking: true, effort: 'low' },
  { id: 'medium', label: t.tierMedium, thinking: true, effort: 'medium' },
  { id: 'high', label: t.tierHigh, thinking: true, effort: 'high' },
];

export const OPENCODE = {
  id: 'opencode',
  title: 'OpenCode',
  description: 'OpenCode 的模型供应商:默认走 Go 订阅的额度,支持 Responses、Chat、Messages 与 Gemini,内置价目与额度面板。',
  describe: { protocols: ['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini'], auth: ['api-key'], local: false, input: ['text', 'image'] },
  defaultBaseUrl: 'https://opencode.ai/inference/go/openai/v1',
  baseUrlSuggestions: [
    'https://opencode.ai/inference/go/openai/v1',
    'https://opencode.ai/inference/openai/v1',
  ],
  localize: (language: Language) => {
    const t = opencodeText(language);
    return { title: t.title, description: t.description, reasoningTiers: tiers(t) };
  },
  // 静态表用中文:describe.json 与市场卡片按这一份导出,中文界面另有 localize() 覆盖。
  reasoningTiers: tiers(opencodeText('zh')),
  serviceTiers: [],
  normalize,
  config: (name: string, _entry: LLMProviderEntry, language: Language) => [optionsGroup(name, language)],
  validateEntry: (entry: LLMProviderEntry, language: Language) => {
    const t = opencodeText(language);
    const { protocol, billing } = optionsOf(entry);
    if (protocol !== undefined && !PROTOCOLS.includes(protocol)) throw new Error(t.badProtocol(PROTOCOLS.join(' / ')));
    if (billing !== undefined && !BILLING_OPTIONS.includes(billing)) throw new Error(t.badBilling(BILLING_OPTIONS.join(' / ')));
  },
  accepts: (entry: LLMProviderEntry, _spec, mime: string) => entry.multimodal === true && mime.startsWith('image/'),
  prices: (entry: LLMProviderEntry, _request, at) => prices(billingOf(entry), at.startedAt),
  contextOverflow: isContextOverflow,
  webUi: opencodeWebUi,
  create(name: string, entry: LLMProviderEntry, host): ProviderInstance {
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const gateway = parseGateway(entry.baseUrl);
    const billing = billingOf(entry);
    const protocol = protocolOf(entry);
    const ledger = new SpendLedger();
    const session = newSession();
    const catalog = createCatalog({ baseUrl: entry.baseUrl, billing, cacheFile: join(host.stateDir, 'models.json') });
    const currentEntry = () => host.currentEntry?.() ?? entry;
    const provider = new OpenCodeProvider({
      baseUrl: gateway ? baseUrlOf(gateway, billing, protocol) : entry.baseUrl,
      protocol,
      apiKey,
      log: host.log,
      media: { enabled: () => currentEntry().multimodal === true, read: host.readBlob },
      keepThinking: host.keepThinking,
      ledger,
    });
    const control: UsageControl = {
      hasKey: () => Boolean(entry.secret && host.secret(entry.secret)),
      read: async () => {
        // The key is read again here: the operator may have saved it after this instance was built.
        const key = entry.secret ? host.secret(entry.secret) : undefined;
        const usage = await readUsage(gateway!, key, session);
        ledger.clear();
        return usage;
      },
      spend: () => ledger.snapshot(),
      advance: (window: UsageWindow) => advancePercent(ledger.snapshot(), window),
    };
    return {
      client: provider,
      control,
      compatibilityKey: () => [name, protocol, billing],
      listModels: () => catalog.listModels(),
      contextWindow: (model: string) => catalog.contextWindow(model),
    };
  },
} satisfies ProviderModule;

export default OPENCODE;
export type { UsageControl };
