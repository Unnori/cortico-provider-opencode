import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { PriceDefinition } from 'cortico/providers/pricebook.ts';
import { prices } from '../pricing.ts';
import { billingOf, optionsOf, protocolOf } from '../options.ts';
import { metadataPrice, type ModelFacts } from '../model-metadata.ts';
import { supportsAttachment } from '../attachments.ts';
import { knownFacts } from '../catalog.ts';

export const MODEL_SETTINGS_PANEL = 'model-settings';
export type InputKind = 'image' | 'audio' | 'video' | 'file';
export interface InputSetting {
  kind: InputKind;
  declared: boolean;
  available: boolean;
  enabled: boolean;
}
export interface ModelInputs {
  model: string;
  input: string[];
  inputs: InputSetting[];
  protocol: string;
  attachmentsEnabled: boolean;
}
export interface InputCapabilities extends ModelInputs {
  /** Effective support for the caller's exact MIME types, without uploading bytes. */
  accepts: Record<string, boolean>;
}
export interface ModelSettings extends ModelInputs {
  automatic: boolean;
  definitions: PriceDefinition[];
  overrides: PriceDefinition[];
}

function inputPolicy(entry: LLMProviderEntry, facts?: ModelFacts) {
  const options = optionsOf(entry);
  return {
    facts: { ...knownFacts(entry.baseUrl, billingOf(entry), entry.spec?.model ?? ''), ...facts },
    protocol: protocolOf(entry), images: entry.multimodal,
    audio: options.inputAudio, video: options.inputVideo, files: options.inputFiles,
    enabled: options.attachments !== 'off',
  };
}

/** Read-only discovery uses the same MIME policy as ProviderModule.accepts and sending. */
export function inputCapabilities(entry: LLMProviderEntry, facts?: ModelFacts, mimes: string[] = []): InputCapabilities {
  const policy = inputPolicy(entry, facts);
  const input = policy.facts.input ?? [];
  const inputs = (['image', 'audio', 'video', 'file'] as const).map(kind => {
    const candidates = input.filter(mime => kind === 'file' ? mime === 'pdf' || mime.includes('/') && !/^(image|audio|video)\//.test(mime)
      : mime === kind || mime.startsWith(`${kind}/`));
    const representative = (mime: string) => mime === 'pdf' ? 'application/pdf' : mime.includes('/') ? mime : `${mime}/${mime === 'image' ? 'png' : mime === 'audio' ? 'wav' : 'mp4'}`;
    const available = candidates.some(mime => supportsAttachment({ facts: policy.facts, protocol: policy.protocol }, representative(mime)));
    return { kind, declared: candidates.length > 0, available,
      enabled: candidates.some(mime => supportsAttachment(policy, representative(mime))) };
  });
  return { model: entry.spec?.model ?? '', input, inputs, protocol: policy.protocol, attachmentsEnabled: policy.enabled,
    accepts: Object.fromEntries(mimes.map(mime => [mime, Boolean(entry.spec?.model) && supportsAttachment(policy, mime)])) };
}

/** Automatic display never turns current defaults into frozen custom prices. */
export function modelSettings(entry: LLMProviderEntry, facts?: ModelFacts, now = new Date().toISOString()): ModelSettings {
  const model = entry.spec?.model ?? '';
  facts = { ...knownFacts(entry.baseUrl, billingOf(entry), model), ...facts };
  const defaults = metadataPrice(model, facts, billingOf(entry), now)
    ?? prices(billingOf(entry), now).find(definition => definition.models.includes(model));
  const overrides = entry.pricing ?? [];
  const byBasis = new Map<string, PriceDefinition>();
  if (defaults) byBasis.set(defaults.basis, defaults);
  const matching = overrides.filter(definition => definition.models.includes(model) || definition.models.includes('*'));
  for (const definition of matching) byBasis.set(definition.basis, definition);
  const { accepts: _accepts, ...inputs } = inputCapabilities(entry, facts);
  return { ...inputs, automatic: !matching.length, definitions: [...byBasis.values()], overrides };
}
