/**
 * The allowance section of the endpoint page, and its data plane. This module ships one panel, so the
 * four built-in connection blocks are listed around it: endpoint, model, allowance, pricing, protocol.
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
import { billingOf } from '../options.ts';
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
      blocks.pricing,
      blocks.protocol,
    ],
    invoke: async (panel, method, args): Promise<AllowanceState | LocalState | ModelState | ReadyState> => {
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
          monthlyLimit: monthlyLimit(model),
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
