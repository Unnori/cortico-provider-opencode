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
import { BILLING_OPTIONS, billingOf, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE, keyNamesOf, optionsOf, protocolOf } from './options.ts';
import { createKeyCursor } from './rotation.ts';
import { guardedMedia, supportsImageMime } from './images.ts';
import { supportsAttachment } from './attachments.ts';
import { metadataPrice } from './model-metadata.ts';
import { createCatalog, knownFacts } from './catalog.ts';
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
        [`providers.${name}.options.goPlan`]: { type: 'string', enum: ['go', 'go-plus', 'go-teams'], title: language === 'en' ? 'Go plan (allowance estimate)' : 'Go 套餐（额度估算）', description: language === 'en' ? 'Used for local allowance estimates; does not change the account billed.' : '仅用于本机额度估算，不改变实际扣费账户。' },
        [`providers.${name}.options.attachments`]: { type: 'string', enum: ['auto', 'off'], title: language === 'en' ? 'Attachments' : '原生附件', description: language === 'en' ? 'Auto follows model declarations; off sends fallback text.' : 'auto 按模型声明自动发送；off 只保留附件文本。图像开关仍可单独关闭图片。' },
        [`providers.${name}.options.keys`]: { type: 'string', title: t.keys, description: t.keysHint },
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
  describe: { protocols: ['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini'], auth: ['api-key'], local: false, input: ['text', 'image', 'audio', 'video'] },
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
    const { protocol, billing, mirrorGoSpend } = optionsOf(entry);
    if (protocol !== undefined && !PROTOCOLS.includes(protocol)) throw new Error(t.badProtocol(PROTOCOLS.join(' / ')));
    if (mirrorGoSpend !== undefined && typeof mirrorGoSpend !== 'boolean') throw new Error('mirrorGoSpend: boolean required');
    if (optionsOf(entry).attachments !== undefined && !['auto', 'off'].includes(optionsOf(entry).attachments!)) throw new Error('attachments: auto / off');
    if (optionsOf(entry).goPlan !== undefined && !['go', 'go-plus', 'go-teams'].includes(optionsOf(entry).goPlan!)) throw new Error('goPlan: go / go-plus / go-teams');
    for (const key of ['inputAudio', 'inputVideo', 'inputFiles'] as const) {
      if (optionsOf(entry)[key] !== undefined && typeof optionsOf(entry)[key] !== 'boolean') throw new Error(`${key}: boolean required`);
    }
    if (billing !== undefined && !BILLING_OPTIONS.includes(billing)) throw new Error(t.badBilling(BILLING_OPTIONS.join(' / ')));
  },
  accepts: (entry: LLMProviderEntry, spec, mime: string) => supportsAttachment({
    facts: knownFacts(entry.baseUrl, billingOf(entry), spec.model), protocol: protocolOf(entry),
    images: entry.multimodal, enabled: optionsOf(entry).attachments !== 'off',
    audio: optionsOf(entry).inputAudio, video: optionsOf(entry).inputVideo, files: optionsOf(entry).inputFiles,
  }, mime),
  prices: (entry: LLMProviderEntry, request, at) => {
    const billing = billingOf(entry);
    const model = request.model ?? '';
    const builtIn = prices(billing, at.startedAt);
    const live = metadataPrice(model, knownFacts(entry.baseUrl, billing, model), billing, at.startedAt);
    const defaults = live ? [...builtIn.filter(price => !price.models.includes(model)), live] : builtIn;
    if (billing !== 'go' || optionsOf(entry).mirrorGoSpend !== true || !model) return defaults;

    // Follow the same last matching override as Core and leave explicit marginal quotes to Core.
    let equivalent = live ?? defaults.find(price => price.models.includes(model));
    for (const definition of entry.pricing ?? []) {
      if (!definition.models.includes(model) && !definition.models.includes('*')) continue;
      if (definition.basis === 'marginal') return defaults;
      equivalent = definition;
    }
    if (!equivalent) return defaults;
    return [...defaults, {
      ...equivalent,
      models: [model],
      basis: 'marginal',
      source: `OpenCode Go subscription estimate · ${equivalent.source}`,
    }];
  },
  contextOverflow: isContextOverflow,
  webUi: opencodeWebUi,
  create(name: string, entry: LLMProviderEntry, host): ProviderInstance {
    const gateway = parseGateway(entry.baseUrl);
    const billing = billingOf(entry);
    const protocol = protocolOf(entry);
    const ledger = new SpendLedger();
    const session = newSession();
    const currentEntry = () => host.currentEntry?.() ?? entry;
    // The names are read from the saved entry, the values through `host.secret`, so an operator can add
    // a second key without this instance being rebuilt.
    const cursor = createKeyCursor({ names: keyNamesOf(entry), read: (keyName) => host.secret(keyName) });
    const catalog = createCatalog({
      baseUrl: entry.baseUrl,
      billing,
      cacheFile: join(host.stateDir, 'models.json'),
      // Read per request: the gateway filters its listing by account, and a key saved after this
      // instance was built must still narrow the list.
      apiKey: () => cursor.current()?.value ?? (entry.secret ? host.secret(entry.secret) : undefined),
    });
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const provider = new OpenCodeProvider({
      baseUrl: gateway ? baseUrlOf(gateway, billing, protocol) : entry.baseUrl,
      protocol,
      apiKey,
      apiKeyOf: () => cursor.current()?.value,
      onKeyRefused: () => cursor.refuse(),
      log: host.log,
      media: guardedMedia({
        enabled: () => currentEntry().multimodal === true,
        read: host.readBlob,
        onDropped: (info) => host.log.warn('opencode: image left out of the request', {
          handle: info.handle, reason: info.reason, mime: info.mime,
          ...(info.reason === 'dimensions' ? { width: info.size.width, height: info.size.height, limit: info.limit, count: info.count } : {}),
        }),
      }),
      attachments: (model) => ({
        facts: catalog.facts(model), protocol, images: currentEntry().multimodal,
        enabled: optionsOf(currentEntry()).attachments !== 'off', read: host.readBlob,
        audio: optionsOf(currentEntry()).inputAudio, video: optionsOf(currentEntry()).inputVideo, files: optionsOf(currentEntry()).inputFiles,
        dropped: (reason, mime) => host.log.warn('opencode: attachment omitted', { reason, mime }),
      }),
      keepThinking: host.keepThinking,
      ledger,
    });
    const control: UsageControl = {
      hasKey: () => Boolean(entry.secret && host.secret(entry.secret)),
      read: async () => {
        // The key is read again here: the operator may have saved it after this instance was built,
        // and allowance belongs to the account the current key pays with.
        const key = cursor.current()?.value ?? (entry.secret ? host.secret(entry.secret) : undefined);
        const usage = await readUsage(gateway!, key, session);
        ledger.clear();
        return usage;
      },
      facts: (model: string) => catalog.facts(model),
      spend: () => ledger.snapshot(),
      advance: (window: UsageWindow) => advancePercent(ledger.snapshot(), window, optionsOf(currentEntry()).goPlan),
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
