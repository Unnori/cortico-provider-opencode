/**
 * Endpoint allowance, model input declarations and automatic/custom pricing panels.
 *
 * `state` answers whether a read is even possible, without touching the network — a brand-new endpoint
 * has no key yet, and asking the gateway then only produces an error nobody caused. `read` asks the
 * gateway; `local` returns this machine's own ledger, so the bars move between reads. `model` states
 * what the chosen model costs and how much context it takes, because the endpoint's own pricing table
 * is an override and stays empty when the module's built-in prices apply.
 */
import type { WebUiPageContribution } from 'cortico/web/shared/webui-protocol.ts';
import type { ProviderWebUiHost } from 'cortico/providers/webui/types.ts';
import { connectionBlocks } from 'cortico/providers/webui/config.ts';
import { validatePrices } from 'cortico/providers/pricebook.ts';
import { MODEL_SETTINGS_PANEL, inputCapabilities, modelSettings, type InputCapabilities, type ModelSettings } from './model-settings.ts';
import { billingOf, optionsOf } from '../options.ts';
import { parseGateway } from '../address.ts';
import { monthlyLimit, prices, type UsageWindow } from '../pricing.ts';
import type { GoUsage, LocalSpend, UsageControl } from '../usage.ts';
import { opencodeText, type OpenCodeText } from '../strings.ts';

export const ALLOWANCE_PANEL = 'allowance';

/** What one read of the allowance section returns. */
export interface AllowanceState {
  usage: GoUsage;
  /** Dollars this process spent per model since the previous read. */
  spend: LocalSpend;
  /** Percent each window moves by on that spend alone, or null when it cannot be attributed. */
  advance: Record<UsageWindow, number | null>;
  readAt: string;
}

/** The same ledger without a network read, for the seconds between reads. */
export interface LocalState {
  spend: LocalSpend;
  advance: Record<UsageWindow, number | null>;
}

/** Whether a read can be attempted at all, answered without touching the network. */
export interface ReadyState {
  ready: boolean;
  /** Why not, worded for the WebUI language; null when a read can go ahead. */
  reason: string | null;
}

/** The chosen model's own facts: what it takes, and what the module charges for it. */
export interface ModelState {
  model: string;
  /** The line the panel prints, worded for the WebUI language. */
  line: string;
  contextWindow: number | null;
  monthlyLimit: number | null;
  rates: {
    input: number | null;
    output: number | null;
    cachedInput: number | null;
    cacheWrite: number | null;
  };
}

function nameOf(args: unknown[], t: OpenCodeText): string {
  const [raw] = args;
  const value = raw as { name?: unknown } | null;
  if (!value || typeof value.name !== 'string' || !value.name) throw new Error(t.instanceRequired);
  return value.name;
}

export function opencodeWebUi(host: ProviderWebUiHost): Partial<WebUiPageContribution> {
  const t = opencodeText(host.language);
  const blocks = connectionBlocks(host.language);
  return {
    config: [],
    // The model block sits right under the connection block: the key goes in at the top, the list and
    // the model picker are the next thing down, and the allowance follows the model it reports on.
    panels: [
      blocks.endpoint,
      blocks.model,
      { id: ALLOWANCE_PANEL, title: t.allowancePanel, description: t.allowancePanelHint, defaultOpen: true },
      { id: MODEL_SETTINGS_PANEL, title: host.language === 'en' ? 'Model inputs and pricing' : '模型输入与计价', defaultOpen: true, getMethods: ['input-capabilities'] },
      blocks.protocol,
    ],
    invoke: async (panel, method, args): Promise<AllowanceState | LocalState | ModelState | ReadyState | ModelSettings | InputCapabilities> => {
      if (panel === MODEL_SETTINGS_PANEL) {
        const name = nameOf(args, t);
        const entry = host.entries().find(item => item.name === name)?.entry;
        if (!entry) throw new Error(t.instanceRequired);
        const facts = (host.instance(name).control as UsageControl | undefined)?.facts?.(entry.spec?.model ?? '');
        if (method === 'input-capabilities') {
          const { mimes = [] } = args[0] as { mimes?: unknown };
          if (!Array.isArray(mimes) || mimes.length > 128 || mimes.some(mime => typeof mime !== 'string' || !mime.includes('/') || mime.length > 256)) throw new Error('Invalid MIME query');
          return inputCapabilities(entry, facts, mimes);
        }
        if (method === 'pricing-state') {
          // The connection editor uses "draft" for new entries. Saved OpenCode entries
          // already have an options object, even when no setting was explicitly chosen.
          if (host.editing && name === 'draft' && entry.options === undefined && billingOf(entry) === 'go') {
            const draft = { ...entry, options: { mirrorGoSpend: true } };
            host.save(name, draft);
            return modelSettings(draft, facts);
          }
          return modelSettings(entry, facts);
        }
        const raw = args[0] as { model?: unknown; definitions?: unknown };
        if (method !== 'pricing-mirror' && raw.model !== entry.spec?.model) throw new Error('Model changed; refresh pricing before applying');
        if (method === 'pricing-mirror') {
          const { enabled } = args[0] as { enabled?: unknown };
          if (billingOf(entry) !== 'go' || typeof enabled !== 'boolean') throw new Error('Invalid Go estimate setting');
          host.save(name, { ...entry, options: { ...entry.options, mirrorGoSpend: enabled } });
        } else if (method === 'input-save') {
          const value = args[0] as { kind?: unknown; enabled?: unknown };
          if (!['image', 'audio', 'video', 'file'].includes(String(value.kind)) || typeof value.enabled !== 'boolean') throw new Error('Invalid input setting');
          const state = modelSettings(entry, facts);
          if (value.enabled && !state.inputs.find(input => input.kind === value.kind)?.available) throw new Error('Input type is not supported by the model or protocol');
          const options = { ...entry.options };
          if (value.enabled) options.attachments = 'auto';
          if (value.kind !== 'image') options[value.kind === 'audio' ? 'inputAudio' : value.kind === 'video' ? 'inputVideo' : 'inputFiles'] = value.enabled;
          host.save(name, { ...entry, options, ...(value.kind === 'image' ? { multimodal: value.enabled } : {}) });
        } else if (method === 'pricing-reset') {
          host.save(name, { ...entry, pricing: (entry.pricing ?? []).filter(definition => !definition.models.includes(String(raw.model)) && !definition.models.includes('*')) });
        } else if (method === 'pricing-save') {
          const definitions = validatePrices(raw.definitions, host.language);
          if (definitions.some(definition => definition.models.length !== 1 || definition.models[0] !== raw.model)) throw new Error('Custom prices must name the selected model');
          host.save(name, { ...entry, pricing: [...(entry.pricing ?? []).filter(definition => !definition.models.includes(String(raw.model)) && !definition.models.includes('*')), ...definitions] });
        } else throw new Error(t.unknownMethod(method));
        return modelSettings(host.entries().find(item => item.name === name)!.entry, facts);
      }
      if (panel !== ALLOWANCE_PANEL) throw new Error(t.unknownMethod(panel));
      if (method !== 'read' && method !== 'local' && method !== 'model' && method !== 'state') throw new Error(t.unknownMethod(method));
      const name = nameOf(args, t);
      const entry = host.entries().find((item) => item.name === name)?.entry;
      if (!entry) throw new Error(t.instanceRequired);

      if (method === 'model') {
        const model = entry.spec?.model;
        if (!model) throw new Error(t.noModelPicked);
        const definition = prices(billingOf(entry), new Date().toISOString()).find((item) => item.models.includes(model));
        const rate = (meter: string): number | null => definition?.rules.find((rule) => rule.meter === meter)?.perMillion ?? null;
        const contextWindow = host.instance(name).contextWindow?.(model) ?? null;
        const input = rate('uncachedInput');
        const output = rate('output');
        const money = (value: number | null): string | null => (value === null ? null : `$${value}`);
        return {
          model,
          line: t.modelRates(model, contextWindow === null ? null : `${contextWindow.toLocaleString('en-US')} tokens`, money(input), money(output)),
          contextWindow,
          monthlyLimit: monthlyLimit(model, optionsOf(entry).goPlan),
          rates: {
            input,
            output,
            cachedInput: rate('cachedInput'),
            cacheWrite: rate('detail:cache_write'),
          },
        };
      }

      // Everything below reads allowance, so the reasons it cannot be read are stated as a value rather
      // than thrown: the panel shows them calmly, and a fresh endpoint shows no error at all.
      const blocked = (reason: string): ReadyState => ({ ready: false, reason });
      const control = host.instance(name).control as UsageControl | undefined;
      if (method === 'state') {
        if (!parseGateway(entry.baseUrl)) return blocked(t.notGateway);
        if (billingOf(entry) !== 'go') return blocked(t.notGo);
        if (!control) return blocked(t.instanceRequired);
        // The page's entry is the browser's draft, so its key value lives in the browser until saved;
        // `host.secret` reads the process environment and the endpoint's `.env`, and neither has it yet.
        if (host.editing) return blocked(t.notSaved);
        if (!entry.secret) return blocked(t.noSecretName);
        if (!control.hasKey()) return blocked(t.noSecretValue);
        return { ready: true, reason: null };
      }

      if (!parseGateway(entry.baseUrl)) throw new Error(t.notGateway);
      if (billingOf(entry) !== 'go') throw new Error(t.notGo);
      if (!control) throw new Error(t.instanceRequired);
      const advance = (): Record<UsageWindow, number | null> => ({
        rolling: control.advance('rolling'),
        weekly: control.advance('weekly'),
        monthly: control.advance('monthly'),
      });
      if (method === 'local') return { spend: control.spend(), advance: advance() };
      if (!control.hasKey()) throw new Error(t.noKeyYet);
      const usage = await control.read();
      return { usage, spend: control.spend(), advance: advance(), readAt: new Date().toISOString() };
    },
  };
}
