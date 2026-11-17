import type { Protocol } from './address.ts';
import type { ModelSpec } from 'cortico/core/types.ts';

/** Wire constraints, separate from model declarations. Sources: docs/protocol-compatibility.md. */
const STANDARD_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const RESPONSE_FILES = new Set([
  'application/pdf', 'application/json', 'application/javascript', 'application/typescript',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf', 'application/vnd.oasis.opendocument.text', 'application/vnd.apple.pages',
  'application/vnd.google-apps.document', 'application/vnd.apple.iwork', 'application/vnd.apple.keynote',
  'application/vnd.google-apps.presentation', 'application/vnd.google-apps.spreadsheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/csv', 'application/x-iif', 'message/rfc822', 'application/x-sql', 'application/x-scala',
  'application/x-rust', 'application/x-powershell', 'application/x-patch', 'application/x-php',
  'application/x-httpd-php', 'application/x-httpd-php-source', 'application/x-bash', 'application/x-awk',
  'application/x-protobuf', 'application/x-terraform', 'application/x-toml', 'application/graphql',
  'application/x-graphql', 'application/x-ndjson', 'application/json5', 'application/x-json5',
  'application/toml', 'application/x-yaml', 'application/yaml', 'application/x-subrip',
]);
const RESPONSE_TEXT = new Set(('plain markdown xml csv tsv x-iif x-shellscript x-rst x-makefile x-lisp x-asm vbscript css x-diff x-patch x-java x-script.python x-python x-c x-c++ x-golang html x-php x-ruby x-sh x-bash x-zsh x-tex x-csharp x-typescript javascript x-go x-rust x-scala x-kotlin x-swift x-lua x-r x-julia x-perl x-objectivec x-objectivec++ x-erlang x-elixir x-haskell x-clojure x-groovy x-dart x-awk jsx tsx x-handlebars x-mustache x-ejs x-jinja2 x-liquid x-erb x-twig x-pug x-jade x-tmpl x-cmake x-dockerfile x-gradle x-ini x-properties x-protobuf x-sql x-sass x-scss x-less x-hcl x-terraform x-toml x-graphql x-yaml x-astro srt x-subrip vtt x-vcard calendar').split(' ').map(type => `text/${type}`));

export function protocolAccepts(protocol: Protocol, mime: string): boolean {
  if (mime.startsWith('image/')) return protocol === 'gemini' || STANDARD_IMAGES.has(mime);
  // User-selected policy: audio/video stay exclusive to native Gemini.
  if (/^(audio|video)\//.test(mime)) return protocol === 'gemini';
  if (protocol === 'gemini') return true; // Caller must also check the model MIME declaration.
  if (protocol === 'chat') return mime === 'application/pdf';
  if (protocol === 'anthropic') return mime === 'application/pdf' || mime === 'text/plain';
  return RESPONSE_TEXT.has(mime) || RESPONSE_FILES.has(mime);
}

/** Snapshot of the documented per-model thinking table, checked 2026-11-17.
 * Unknown model IDs deliberately receive no model-specific native thinking fields. */
const GEMINI_LEVELS: Record<string, readonly string[]> = {
  'gemini-4-carbon': ['low', 'medium', 'high'],
  'gemini-4-argon': ['low', 'medium', 'high'],
  'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash-lite': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
  'gemini-3.1-flash-lite': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.1-flash-lite-image': ['minimal', 'high'],
  'gemini-3-flash-preview': ['minimal', 'low', 'medium', 'high'],
  'gemini-3-pro-preview': ['low', 'high'],
};
const CLAUDE_ALWAYS = new Set(['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2',
  'claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-5-2', 'claude-mythos-preview', 'claude-opus-5-5']);
const CLAUDE_ADAPTIVE = new Set([...CLAUDE_ALWAYS, 'claude-opus-5', 'claude-sonnet-5-5',
  'claude-sonnet-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']);
const CLAUDE_BUDGET = new Set(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']);

export function geminiThinking(spec: ModelSpec): Record<string, unknown> | undefined {
  const model = spec.model.replace(/^models\//, '');
  if (['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'].includes(model)) {
    return { thinkingBudget: spec.thinking ? -1 : model === 'gemini-2.5-pro' ? 128 : 0 };
  }
  const levels = Object.hasOwn(GEMINI_LEVELS, model) ? GEMINI_LEVELS[model] : undefined;
  if (!levels) return undefined;
  const requested = spec.reasoningEffort ?? 'medium';
  const level = !spec.thinking ? levels[0] : levels.includes(requested) ? requested
    : levels.includes('medium') ? 'medium' : 'high';
  return { thinkingLevel: level.toUpperCase() };
}

export function messagesThinking(spec: ModelSpec): Record<string, unknown> {
  const model = spec.model.replace(/-\d{8}$/, '');
  if (!CLAUDE_ADAPTIVE.has(model) && !CLAUDE_BUDGET.has(model)) return {};
  const effort = ['low', 'medium', 'high'].includes(spec.reasoningEffort ?? '') ? spec.reasoningEffort! : 'medium';
  if (!spec.thinking) {
    if (CLAUDE_ALWAYS.has(model)) return { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } };
    return { thinking: { type: model === 'claude-sonnet-5-5' ? 'between_tools' : 'disabled' } };
  }
  if (CLAUDE_BUDGET.has(model)) {
    if ((spec.maxTokens ?? 8192) <= 1024) throw new Error('Claude 4.5 thinking requires max_tokens greater than 1024');
    // No caller-supplied budget exists: use the documented minimum, never exceed max_tokens.
    return { thinking: { type: 'enabled', budget_tokens: 1024 },
      ...(model === 'claude-opus-4-5' ? { output_config: { effort } } : {}) };
  }
  return { thinking: { type: 'adaptive' }, output_config: { effort } };
}

export function messagesSamplingAllowed(spec: ModelSpec): boolean {
  const model = spec.model.replace(/-\d{8}$/, '');
  if (CLAUDE_ALWAYS.has(model) || CLAUDE_ADAPTIVE.has(model) && !model.endsWith('-4-6')) return false;
  return !(spec.thinking && (CLAUDE_BUDGET.has(model) || CLAUDE_ADAPTIVE.has(model)));
}

export function messagesForcedToolsAllowed(spec: ModelSpec): boolean {
  const model = spec.model.replace(/-\d{8}$/, '');
  return !new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5-2',
    'claude-mythos-5-1', 'claude-mythos-5-2']).has(model) && !(spec.thinking && CLAUDE_BUDGET.has(model));
}

/** Chat tool messages accept text only. Emit media after all parallel results. */
export function chatToolMedia(messages: Array<Record<string, any>>): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  let media: Array<Record<string, any>> = [];
  const flush = () => {
    if (media.length) out.push({ role: 'user', content: media });
    media = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') flush();
    if (message.role !== 'tool' || !Array.isArray(message.content)) { out.push(message); continue; }
    const text = message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    media.push(...message.content.filter((part: any) => part.type !== 'text'));
    out.push({ ...message, content: text });
  }
  flush();
  return out;
}
