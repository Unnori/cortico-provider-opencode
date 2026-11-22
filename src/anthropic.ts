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
import type { GenerateOptions, Generation, TokenMeters } from 'cortico/core/generation.ts';
import type { Request, Response, StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { ChatResponseAssembly, type ResponseAssembly } from 'cortico/providers/transport/response-assembly.ts';
import { StreamErrorEvent } from 'cortico/providers/transport/errors.ts';
import type { CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import { renderMessagesWithMedia } from 'cortico/providers/transport/history.ts';
import { nativeChatInput, requestContext, requestSpec, requestTools } from 'cortico/providers/transport/native-input.ts';
import { RequestIdentity, type RequestCredentials } from './identity.ts';
import { messagesForcedToolsAllowed, messagesSamplingAllowed, messagesThinking } from './protocol-contract.ts';
import { parseDataUrl } from './attachments.ts';
import { chatImageCount, mediaForRequest } from './images.ts';

/** The Messages API requires a limit; this one applies when the endpoint states none. */
const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';

type Block = Record<string, unknown>;
type Rendered = Record<string, any>;
const THINKING_PREFIX = 'opencode:messages:thinking:';
const MAX_THINKING_CHARS = 16 * 1024 * 1024;

/** Restore the exact signed blocks recorded by this dialect, never invent a signature. */
function thinkingByCall(request: Request, options: GenerateOptions): Map<string, Block[]> {
  const byCall = new Map<string, Block[]>();
  let blocks: Block[] = [];
  for (const entry of requestContext(request, options)) {
    const item = entry.item;
    if (item.type === 'reasoning') {
      blocks = [];
      const sealed = item.encrypted_content;
      const owner = entry.context.origin;
      if (owner && options.origin && (owner.instance !== options.origin.instance || owner.module !== options.origin.module
        || owner.compatibilityDomain !== options.origin.compatibilityDomain)) continue;
      if (typeof sealed !== 'string' || sealed.length > MAX_THINKING_CHARS || !sealed.startsWith(THINKING_PREFIX)) continue;
      try {
        const value = JSON.parse(sealed.slice(THINKING_PREFIX.length));
        if (value.model === request.model && Array.isArray(value.blocks)) blocks = value.blocks;
      } catch { /* A foreign or invalid opaque block cannot be replayed as Anthropic thinking. */ }
    } else if (item.type === 'function_call') byCall.set(item.call_id, blocks);
    else if (item.type === 'function_call_output' || item.type === 'message' && item.role === 'user') blocks = [];
  }
  return byCall;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part === 'object' && (part as Rendered).type === 'text'
    ? String((part as Rendered).text ?? '') : '')).join('');
}

/** Text and media as Messages blocks; an attachment the renderer could not read is already gone. */
function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const part of content) {
    const value = part as Rendered;
    if (value?.type === 'text' && typeof value.text === 'string' && value.text) blocks.push({ type: 'text', text: value.text });
    else if (value?.type === 'file') {
      const data = parseDataUrl(String(value.file?.file_data ?? ''));
      if (data) blocks.push({ type: 'document', source: data.mime === 'text/plain'
        ? { type: 'text', media_type: 'text/plain', data: data.bytes.toString('utf8') }
        : { type: 'base64', media_type: data.mime, data: data.bytes.toString('base64') }, ...(value.file?.filename ? { title: value.file.filename } : {}) });
    }
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
  const input = nativeChatInput(request, options);
  const rendered = renderMessagesWithMedia(input, mediaForRequest(media, chatImageCount(input))) as Rendered[];
  const thinking = thinkingByCall(request, options);
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
      const signed = new Set<Block[]>();
      for (const call of (message.tool_calls ?? []) as Rendered[]) {
        const previous = thinking.get(call.id);
        if (previous?.length && !signed.has(previous)) { blocks.unshift(...previous); signed.add(previous); }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: parseArguments(call.function?.arguments) });
      }
      push('assistant', blocks);
      continue;
    }
    if (message.role === 'tool') {
      // Core's external event frames and normal tool results can both carry media.
      // Preserve native blocks inside the result; plain-text results keep their string form.
      const blocks = blocksOf(message.content);
      const content = blocks.some(block => block.type !== 'text') ? blocks : textOf(message.content);
      push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content }]);
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
  if (spec.temperature !== undefined && messagesSamplingAllowed(spec)) body.temperature = spec.temperature;
  Object.assign(body, messagesThinking({ ...spec, maxTokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS }));
  const tools = requestTools(request);
  if (tools?.length) body.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  if (tools?.length && request.tool_choice != null) {
    const choice = request.tool_choice;
    if ((choice === 'required' || typeof choice === 'object' && choice.type === 'function') && !messagesForcedToolsAllowed(spec)) {
      throw new Error(`${spec.model} does not support forced tool use with this thinking mode; use tool_choice: auto`);
    }
    if (typeof choice === 'string') body.tool_choice = { type: choice === 'required' ? 'any' : choice };
    else if (choice.type === 'function') body.tool_choice = { type: 'tool', name: choice.name };
    else throw new Error('Messages cannot map this tool_choice');
  }
  if (tools?.length && request.parallel_tool_calls === false) {
    body.tool_choice = { type: 'auto', ...(body.tool_choice as object ?? {}), disable_parallel_tool_use: true };
  }
  return body;
}

/** The stop reasons the framework knows; anything else reads as a normal stop. */
const STOP_REASONS: Readonly<Record<string, string>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
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
  const reasoning = number(raw.output_tokens_details?.thinking_tokens);
  const prompt = input === null ? null : input + (read ?? 0) + (write ?? 0);
  return {
    ...(typeof raw?.cost === 'number' ? { cost: raw.cost } : {}),
    ...(raw?.opencode ? { opencode: raw.opencode } : {}),
    ...(prompt === null ? {} : { prompt_tokens: prompt }),
    ...(output === null ? {} : { completion_tokens: output }),
    ...(reasoning === null ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } }),
    ...(prompt === null || output === null ? {} : { total_tokens: prompt + output }),
    ...(read === null ? {} : { prompt_tokens_details: { cached_tokens: read } }),
  };
}

/** Empty tool blocks still consume memory even when they consume no character budget. */
export const MAX_MESSAGES_TOOL_CALLS = 4096;

/** Messages events translated into the Chat chunks `ChatResponseAssembly` validates. */
export class MessagesAssembly implements ResponseAssembly {
  private readonly inner: ChatResponseAssembly;
  private readonly tools = new Map<number, { id: string; name: string; arguments: string }>();
  private toolCharacters = 0;
  private readonly maxToolCharacters: number;
  private stopReason = 'end_turn';
  private usage: Rendered | null = null;
  /** Set once the terminal chunk has been fed, so `finish` never feeds a second one. */
  private closed = false;
  private readonly thinking: Rendered[] = [];
  private readonly thinkingAt = new Map<number, Rendered>();
  private thinkingCharacters = 0;

  constructor(request: Request) {
    this.inner = new ChatResponseAssembly(request);
    // Tool identities and arguments remain private until the block closes.
    this.maxToolCharacters = (request.max_output_tokens ?? 32768) * 12;
  }

  private countToolCharacters(characters: number): void {
    if (characters > this.maxToolCharacters - this.toolCharacters) {
      throw new StreamErrorEvent('Messages tool data exceeded the output character limit');
    }
    this.toolCharacters += characters;
  }

  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    const event = payload as Rendered;
    const type = event?.type;
    if (type === 'error') throw new StreamErrorEvent(JSON.stringify(event));
    if (type === 'message_start') {
      const message = event.message ?? {};
      // `message_start` carries the token counts as the first estimate, and a stream that ends before
      // `message_delta` never repeats them; keeping them here is what makes usage readable at all.
      if (message.usage) this.usage = { ...(this.usage ?? {}), ...message.usage };
      this.inner.feed({ id: message.id, model: message.model, usage: chatUsage(this.usage), choices: [{ delta: {} }] }, emit);
      return;
    }
    if (type === 'content_block_start') {
      const block = event.content_block ?? {};
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const saved = block.type === 'thinking' ? { type: 'thinking', thinking: String(block.thinking ?? ''), signature: String(block.signature ?? '') }
          : { type: 'redacted_thinking', data: String(block.data ?? '') };
        this.thinkingCharacters += JSON.stringify(saved).length;
        if (this.thinkingCharacters > MAX_THINKING_CHARS) throw new StreamErrorEvent('Messages thinking data exceeded the buffer limit');
        this.thinking.push(saved);
        this.thinkingAt.set(event.index, saved);
        if (block.thinking) this.inner.feed({ choices: [{ delta: { reasoning_content: block.thinking } }] }, emit);
      }
      if (block.type === 'tool_use' && Number.isInteger(event.index)) {
        if (!this.tools.has(event.index) && this.tools.size >= MAX_MESSAGES_TOOL_CALLS) {
          throw new StreamErrorEvent('Messages response exceeded the tool block limit');
        }
        const id = String(block.id ?? '');
        const name = String(block.name ?? '');
        this.countToolCharacters(id.length + name.length);
        this.tools.set(event.index, { id, name, arguments: '' });
      }
      return;
    }
    if (type === 'content_block_delta') {
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        this.inner.feed({ choices: [{ delta: { content: delta.text } }] }, emit);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        const block = this.thinkingAt.get(event.index);
        if (block) block.thinking += delta.thinking;
        this.thinkingCharacters += delta.thinking.length;
        if (this.thinkingCharacters > MAX_THINKING_CHARS) throw new StreamErrorEvent('Messages thinking data exceeded the buffer limit');
        this.inner.feed({ choices: [{ delta: { reasoning_content: delta.thinking } }] }, emit);
      } else if (delta.type === 'signature_delta') {
        const signature = String(delta.signature ?? '');
        this.thinkingCharacters += signature.length;
        if (this.thinkingCharacters > MAX_THINKING_CHARS) throw new StreamErrorEvent('Messages thinking data exceeded the buffer limit');
        const block = this.thinkingAt.get(event.index);
        if (block?.type === 'thinking') block.signature += signature;
      } else if (delta.type === 'input_json_delta') {
        const tool = this.tools.get(event.index);
        if (tool) {
          const fragment = String(delta.partial_json ?? '');
          this.countToolCharacters(fragment.length);
          tool.arguments += fragment;
        }
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
      if (!this.stopReason) { this.inner.feed({ usage: chatUsage(this.usage), choices: [{ delta: {} }] }, emit); return; }
      if (!STOP_REASONS[this.stopReason]) throw new StreamErrorEvent(`Messages generation ended with ${this.stopReason}`);
      // The terminal chunk closes here rather than on `message_stop`: the stop reason and the final usage
      // arrive together on `message_delta`, and a stream cut after it still leaves a complete response.
      const usage = chatUsage(this.usage);
      this.inner.feed({
        ...(usage ? { usage } : {}),
        choices: [{ delta: {}, finish_reason: STOP_REASONS[this.stopReason] ?? 'stop' }],
      }, emit);
      this.closed = true;
      return;
    }
  }

  /** A missing terminal delta stays a failure; the wrapper can retain partial text as incomplete. */
  finish(emit: (event: StreamEvent) => void): Response {
    if (!this.closed) throw new StreamErrorEvent('Messages stream ended without message_delta');
    const response = this.inner.finish(emit);
    const blocks = this.thinking.filter(block => block.type === 'redacted_thinking' || block.signature);
    if (blocks.length) {
      let reasoning = response.output.find(item => item.type === 'reasoning');
      if (!reasoning) {
        reasoning = { type: 'reasoning', id: `rs_${crypto.randomUUID()}`, summary: [], content: [] };
        response.output.unshift(reasoning);
      }
      reasoning.encrypted_content = THINKING_PREFIX + JSON.stringify({ model: response.model, blocks });
    }
    return response;
  }
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
    assembler.feed({ type: 'content_block_start', index, content_block: block.type === 'thinking' ? { ...block, thinking: '', signature: '' } : block }, ignore);
    if (block.type === 'text' && block.text) assembler.feed({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }, ignore);
    if (block.type === 'tool_use') assembler.feed({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }, ignore);
    if (block.type === 'thinking') {
      assembler.feed({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }, ignore);
      assembler.feed({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }, ignore);
    }
    assembler.feed({ type: 'content_block_stop', index }, ignore);
  });
  assembler.feed({ type: 'message_delta', delta: { stop_reason: data.stop_reason }, usage: data.usage }, ignore);
  const response = assembler.finish(ignore);
  return { response, meters: assembler.meters(), serviceTier: assembler.serviceTier() };
}

export interface MessagesOptions extends RequestCredentials {
  baseUrl: string;
  log?: Logger;
  media?: CompatMediaOptions;
}

export class OpenCodeMessages extends OpenAIHttpClient {
  private readonly media?: CompatMediaOptions;
  private readonly identity: RequestIdentity;

  constructor(opts: MessagesOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.chatPath = '/messages';
    this.identity = new RequestIdentity(opts);
    this.media = opts.media;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  override respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    return this.identity.run(options.sessionId, () => super.respond(request, options));
  }

  protected override buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    const body = buildMessagesBody(request, options, this.media);
    // The base builder is unreachable here, and the stream flag is set by it, so this method must set
    // the flag itself or every request goes out unary and the assembly never sees an SSE frame.
    if (options.onEvent) this.applyStreamFlags(body);
    return body;
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

  protected override async onAuthError(): Promise<boolean> {
    return this.identity.keyRefused();
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.identity.headers(),
    };
  }
}
