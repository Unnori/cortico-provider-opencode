/**
 * The Messages API family, served at `<gateway>/[go/]anthropic/v1/messages`. Like the other families it
 * reaches every text model, so this dialect exists for callers that want Anthropic's request shape.
 *
 * Requests go out as Messages and come back as Messages; `MessagesAssembly` translates the event
 * stream into the Chat chunks the framework already validates, so Items, tool calls and meters take the
 * same path as the other dialects instead of a second validator written here.
 *
 * Thinking is not sent. The Messages API states it as a token budget, and Console's translation of an
 * OpenAI-style effort onto one is not documented.
 */
import type { Logger, ModelSpec } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { GenerateOptions } from 'cortico/core/generation.ts';
import type { Request, Response, StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import type { TokenMeters } from 'cortico/core/generation.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { ChatResponseAssembly, type ResponseAssembly } from 'cortico/providers/transport/response-assembly.ts';
import { StreamErrorEvent } from 'cortico/providers/transport/errors.ts';
import type { CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import { renderMessagesWithMedia } from 'cortico/providers/transport/history.ts';
import { nativeChatInput, requestSpec, requestTools } from 'cortico/providers/transport/native-input.ts';
import { identityHeaders, newSession } from './identity.ts';

/** The Messages API requires a limit; this one applies when the endpoint states none. */
const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';

type Block = Record<string, unknown>;
type Rendered = Record<string, any>;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part === 'object' && (part as Rendered).type === 'text'
    ? String((part as Rendered).text ?? '') : '')).join('');
}

/** Text and image parts as Messages blocks; an attachment the renderer could not read is already gone. */
function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const part of content) {
    const value = part as Rendered;
    if (value?.type === 'text' && typeof value.text === 'string' && value.text) blocks.push({ type: 'text', text: value.text });
    else if (value?.type === 'image_url') {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(String(value.image_url?.url ?? ''));
      if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
    }
  }
  return blocks;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function buildMessagesBody(request: Request, options: GenerateOptions, media?: CompatMediaOptions): Record<string, unknown> {
  const spec = requestSpec(request, options);
  const rendered = renderMessagesWithMedia(nativeChatInput(request, options), media) as Rendered[];
  const system: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of rendered) {
    if (message.role === 'system') {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === 'assistant') {
      const blocks = blocksOf(message.content);
      for (const call of (message.tool_calls ?? []) as Rendered[]) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: parseArguments(call.function?.arguments) });
      }
      push('assistant', blocks);
      continue;
    }
    if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: textOf(message.content) }]);
      continue;
    }
    push('user', blocksOf(message.content));
  }
  const body: Record<string, unknown> = {
    model: spec.model,
    max_tokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system.length) body.system = system.join('\n\n');
  if (spec.temperature !== undefined) body.temperature = spec.temperature;
  const tools = requestTools(request);
  if (tools?.length) body.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  return body;
}

/** The stop reasons the framework knows; anything else reads as a normal stop. */
const STOP_REASONS: Readonly<Record<string, string>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

/** Anthropic usage counts cache reads and writes beside the prompt; Chat-shaped usage carries them in the prompt. */
function chatUsage(raw: Rendered | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const input = number(raw.input_tokens);
  const output = number(raw.output_tokens);
  const read = number(raw.cache_read_input_tokens);
  const write = number(raw.cache_creation_input_tokens);
  const prompt = input === null ? null : input + (read ?? 0) + (write ?? 0);
  return {
    ...(prompt === null ? {} : { prompt_tokens: prompt }),
    ...(output === null ? {} : { completion_tokens: output }),
    ...(prompt === null || output === null ? {} : { total_tokens: prompt + output }),
    ...(read === null ? {} : { prompt_tokens_details: { cached_tokens: read } }),
  };
}

/** Messages events translated into the Chat chunks `ChatResponseAssembly` validates. */
export class MessagesAssembly implements ResponseAssembly {
  private readonly inner: ChatResponseAssembly;
  private readonly tools = new Map<number, { id: string; name: string; arguments: string }>();
  private stopReason = 'end_turn';
  private usage: Rendered | null = null;

  constructor(request: Request) {
    this.inner = new ChatResponseAssembly(request);
  }

  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    const event = payload as Rendered;
    const type = event?.type;
    if (type === 'error') throw new StreamErrorEvent(JSON.stringify(event));
    if (type === 'message_start') {
      const message = event.message ?? {};
      this.inner.feed({ id: message.id, model: message.model, choices: [{ delta: {} }] }, emit);
      return;
    }
    if (type === 'content_block_start') {
      const block = event.content_block ?? {};
      if (block.type === 'tool_use' && Number.isInteger(event.index)) {
        this.tools.set(event.index, { id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: '' });
      }
      return;
    }
    if (type === 'content_block_delta') {
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        this.inner.feed({ choices: [{ delta: { content: delta.text } }] }, emit);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        this.inner.feed({ choices: [{ delta: { reasoning_content: delta.thinking } }] }, emit);
      } else if (delta.type === 'input_json_delta') {
        const tool = this.tools.get(event.index);
        if (tool) tool.arguments += String(delta.partial_json ?? '');
      }
      return;
    }
    // A tool call closes whole: Core executes a call only after its arguments are complete.
    if (type === 'content_block_stop') {
      const tool = this.tools.get(event.index);
      if (tool) {
        const index = [...this.tools.keys()].indexOf(event.index);
        this.inner.feed({ choices: [{ delta: { tool_calls: [{ index, id: tool.id, function: { name: tool.name, arguments: tool.arguments || '{}' } }] } }] }, emit);
      }
      return;
    }
    if (type === 'message_delta') {
      if (typeof event.delta?.stop_reason === 'string') this.stopReason = event.delta.stop_reason;
      if (event.usage) this.usage = { ...(this.usage ?? {}), ...event.usage };
      // The terminal chunk closes here rather than on `message_stop`: the stop reason and the final usage
      // arrive together on `message_delta`, and a stream cut after it still leaves a complete response.
      const usage = chatUsage(this.usage);
      this.inner.feed({
        ...(usage ? { usage } : {}),
        choices: [{ delta: {}, finish_reason: STOP_REASONS[this.stopReason] ?? 'stop' }],
      }, emit);
      return;
    }
  }

  finish(emit: (event: StreamEvent) => void): Response { return this.inner.finish(emit); }
  snapshot(): Response | null { return this.inner.snapshot(); }
  meters(): TokenMeters { return this.inner.meters(); }
  serviceTier(): string | null { return this.inner.serviceTier(); }
}

export function parseMessages(raw: unknown, request: Request): { response: Response; meters: TokenMeters; serviceTier: string | null } {
  const data = raw as Rendered;
  if (!data || typeof data !== 'object' || !Array.isArray(data.content)) throw new Error('Messages response lacks content');
  const assembler = new MessagesAssembly(request);
  const ignore = (() => {}) as unknown as (event: StreamEvent) => void;
  assembler.feed({ type: 'message_start', message: { id: data.id, model: data.model } }, ignore);
  data.content.forEach((block: Rendered, index: number) => {
    assembler.feed({ type: 'content_block_start', index, content_block: block }, ignore);
    if (block.type === 'text' && block.text) assembler.feed({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }, ignore);
    if (block.type === 'tool_use') assembler.feed({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }, ignore);
    assembler.feed({ type: 'content_block_stop', index }, ignore);
  });
  assembler.feed({ type: 'message_delta', delta: { stop_reason: data.stop_reason }, usage: data.usage }, ignore);
  const response = assembler.finish(ignore);
  return { response, meters: assembler.meters(), serviceTier: assembler.serviceTier() };
}

export interface MessagesOptions {
  baseUrl: string;
  apiKey?: string;
  log?: Logger;
  media?: CompatMediaOptions;
}

export class OpenCodeMessages extends OpenAIHttpClient {
  private readonly apiKey?: string;
  private readonly media?: CompatMediaOptions;
  private session = '';
  private readonly fallback = newSession();

  constructor(opts: MessagesOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.chatPath = '/messages';
    this.apiKey = opts.apiKey;
    this.media = opts.media;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  protected override buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    this.session = options.sessionId ?? '';
    return buildMessagesBody(request, options, this.media);
  }

  /** The Chat body builder is unreachable here: `buildResponseBody` is overridden whole. */
  protected buildBody(): never {
    throw new Error('OpenCodeMessages does not build Chat Completions bodies');
  }

  protected override responseAssembly(request: Request): ResponseAssembly {
    return new MessagesAssembly(request);
  }

  protected override parseResponse(raw: unknown, request: Request): { response: Response; meters: TokenMeters; serviceTier: string | null } {
    return parseMessages(raw, request);
  }

  protected override applyStreamFlags(body: Record<string, unknown>): void {
    body.stream = true;
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...identityHeaders(this.session || this.fallback),
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }
}
