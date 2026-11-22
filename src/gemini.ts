/**
 * The Gemini API family, served at `<gateway>/[go/]google/v1beta/models/<model>:generateContent`, or
 * `:streamGenerateContent?alt=sse` when streaming. The method and the model are part of the path, so the
 * path is set per request; `super.respond` reads it before its first await, so concurrent requests
 * cannot observe each other's path.
 *
 * Gateway authentication follows OpenCode's documented `Authorization: Bearer` header.
 *
 * Like the other dialects the reply is translated into the Chat chunks the framework validates, so
 * items, tool calls, finish reasons and meters take the same path.
 */
import type { Logger } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { standardUsage, type GenerateOptions, type Generation, type GenerationError, type TokenMeters } from 'cortico/core/generation.ts';
import type { Request, Response, StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { createResponse } from 'cortico/protocol/open-responses/index.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { ChatResponseAssembly, type ResponseAssembly } from 'cortico/providers/transport/response-assembly.ts';
import { chatMeters } from 'cortico/providers/transport/response-meters.ts';
import { StreamErrorEvent } from 'cortico/providers/transport/errors.ts';
import { renderMessagesWithMedia, type CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import { nativeChatInput, requestSpec, requestTools } from 'cortico/providers/transport/native-input.ts';
import { RequestIdentity, type RequestCredentials } from './identity.ts';
import { geminiThinking } from './protocol-contract.ts';
import { SignatureStore } from './signatures.ts';
import { parseDataUrl } from './attachments.ts';
import { chatImageCount, mediaForRequest } from './images.ts';

type Shape = Record<string, any>;

type Part = Record<string, unknown>;

const DEFAULT_MAX_TOKENS = 8192;

/**
 * The turn appended when history ends on a model turn. It has to be a user turn for the API to accept
 * the request; the wording keeps the nudge small and neutral so it does not steer the reply.
 */
const CONTINUE_PROMPT = '(继续。)'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part === 'object' && (part as Shape).type === 'text'
    ? String((part as Shape).text ?? '') : '')).join('');
}

/** Text and inline media parts; Gemini takes attachment bytes inline, base64 encoded. */
function partsOf(content: unknown): Part[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const part of content) {
    const value = part as Shape;
    if (value?.type === 'text' && typeof value.text === 'string' && value.text) parts.push({ text: value.text });
    else if (value?.type === 'file') {
      const data = parseDataUrl(String(value.file?.file_data ?? ''));
      if (data) parts.push({ inlineData: { mimeType: data.mime, data: data.bytes.toString('base64') } });
    }
    else if (value?.type === 'image_url') {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(String(value.image_url?.url ?? ''));
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }
  return parts;
}

/**
 * A tool result names its function, and the call id is the only thing the framework keeps; the id → name
 * map is rebuilt from the assistant turns ahead of the results.
 */
export function buildGeminiBody(request: Request, options: GenerateOptions, media?: CompatMediaOptions, signatures?: SignatureStore): Record<string, unknown> {
  const spec = requestSpec(request, options);
  const input = nativeChatInput(request, options);
  const rendered = renderMessagesWithMedia(input, mediaForRequest(media, chatImageCount(input))) as Shape[];
  const names = new Map<string, string>();
  for (const message of rendered) {
    for (const call of (message.tool_calls ?? []) as Shape[]) {
      if (typeof call.id === 'string' && typeof call.function?.name === 'string') names.set(call.id, call.function.name);
    }
  }
  const system: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
  const push = (role: 'user' | 'model', parts: Part[]): void => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      // Keep parallel responses together, then append any immediately following user text.
      // A separate text-only user turn after tool responses can fail on Gemini 4 Argon.
      const lastIsResponse = last.parts.some((part) => 'functionResponse' in part);
      const partsAreResponses = parts.every((part) => 'functionResponse' in part);
      if (lastIsResponse ? partsAreResponses || parts.every((part) => 'text' in part) : !partsAreResponses) {
        last.parts.push(...parts);
        return;
      }
    }
    contents.push({ role, parts });
  };
  // Core delivers external events as tool results. Keep their native media after the
  // complete response turn and before the next user/model turn, so media stays
  // with its source result and parallel functionCall/functionResponse counts match.
  let toolMedia: Part[] = [];
  const flushToolMedia = (): void => {
    if (toolMedia.length) push('user', toolMedia);
    toolMedia = [];
  };
  for (const message of rendered) {
    if (message.role !== 'tool') flushToolMedia();
    if (message.role === 'system') {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === 'assistant') {
      const parts = partsOf(message.content);
      for (const call of (message.tool_calls ?? []) as Shape[]) {
        // Gemini 3+ rejects a replayed functionCall without a signature; the store replays the real one
        // and falls back to the validator-skip value for calls it never saw (older history, a restart).
        const signature = signatures?.replay(typeof call.id === 'string' ? call.id : undefined);
        parts.push({
          functionCall: { name: call.function?.name, args: parseArguments(call.function?.arguments) },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      }
      push('model', parts);
      continue;
    }
    if (message.role === 'tool') {
      const name = names.get(String(message.tool_call_id ?? '')) ?? 'tool';
      push('user', [{ functionResponse: { name, response: { result: textOf(message.content) } } }]);
      toolMedia.push(...partsOf(message.content).filter((part) => 'inlineData' in part));
      continue;
    }
    push('user', partsOf(message.content));
  }
  flushToolMedia();
  // Gemini refuses a request whose last content is `model` ("Requests ending with a model turn are not
  // supported"). That happens whenever the framework sends history that ends on an assistant turn — for
  // example a round cut short after a tool call, or a turn that only pushed events.
  const tail = contents[contents.length - 1];
  if (tail && tail.role === 'model') contents.push({ role: 'user', parts: [{ text: CONTINUE_PROMPT }] });
  const body: Record<string, unknown> = { contents };

  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  const generationConfig: Record<string, unknown> = { maxOutputTokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS };
  if (spec.temperature !== undefined) generationConfig.temperature = spec.temperature;
  const thinking = geminiThinking(spec);
  if (thinking) generationConfig.thinkingConfig = thinking;
  body.generationConfig = generationConfig;
  const tools = requestTools(request);
  if (tools?.length) {
    body.tools = [{ functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: geminiSchema(tool.parameters),
    })) }];
    if (request.tool_choice != null) {
      const choice = request.tool_choice;
      const config = typeof choice === 'string'
        ? { mode: choice === 'none' ? 'NONE' : choice === 'required' ? 'ANY' : 'AUTO' }
        : choice.type === 'function' ? { mode: 'ANY', allowedFunctionNames: [choice.name] } : undefined;
      if (!config) throw new Error('Gemini cannot map this tool_choice');
      body.toolConfig = { functionCallingConfig: config };
    }
  }
  return body;
}

/** Use the documented JSON Schema field instead of the restricted OpenAPI Schema.
 * Preserve numeric enums, refs, unions and const without changing tool argument types. */
export function geminiSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object', properties: {} };
  const out = structuredClone(schema) as Record<string, unknown>;
  if (out.type === 'object' && out.properties === undefined) out.properties = {};
  return out;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

const FINISH_REASONS: Readonly<Record<string, string>> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  IMAGE_SAFETY: 'content_filter',
  IMAGE_PROHIBITED_CONTENT: 'content_filter',
  IMAGE_RECITATION: 'content_filter',
};

export class GeminiMalformedResponse extends StreamErrorEvent {
  constructor(message: string, readonly meters: TokenMeters, readonly responseId?: string) {
    super(message);
  }
}

/** A malformed terminal frame does not confirm pending tool calls. Keep only streamed text. */
export function incompleteGeminiResponse(request: Request, error: GenerationError, failure: GeminiMalformedResponse): Generation {
  const response = error.partial ?? createResponse(failure.responseId ?? `resp_${crypto.randomUUID()}`, request);
  return {
    response: {
      ...response,
      output: response.output.flatMap(item => {
        if (item.type !== 'message') return [];
        const content = item.content.filter(part => part.type === 'output_text' && part.text);
        return content.length ? [{ ...item, status: 'incomplete', content }] : [];
      }),
      status: 'incomplete',
      completed_at: Math.floor(Date.now() / 1000),
      incomplete_details: { reason: 'upstream_malformed_response' },
      usage: standardUsage(failure.meters),
    },
    origin: error.origin,
    attempts: error.attempts,
  };
}

function chatUsage(raw: Shape | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const prompt = number(raw.promptTokenCount);
  const candidates = number(raw.candidatesTokenCount);
  const thoughts = number(raw.thoughtsTokenCount);
  const cached = number(raw.cachedContentTokenCount);
  return {
    ...(typeof raw?.cost === 'number' ? { cost: raw.cost } : {}),
    ...(raw?.opencode ? { opencode: raw.opencode } : {}),
    ...(prompt === null ? {} : { prompt_tokens: prompt }),
    ...(candidates === null ? {} : { completion_tokens: candidates + (thoughts ?? 0) }),
    ...(thoughts === null ? {} : { completion_tokens_details: { reasoning_tokens: thoughts } }),
    ...(number(raw.totalTokenCount) !== null ? { total_tokens: raw.totalTokenCount }
      : prompt === null || candidates === null ? {} : { total_tokens: prompt + candidates + (thoughts ?? 0) }),
    ...(cached === null ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
  };
}

/** Gemini chunks translated into the Chat chunks `ChatResponseAssembly` validates. */
export class GeminiAssembly implements ResponseAssembly {
  private readonly inner: ChatResponseAssembly;
  private calls = 0;
  private finishReason: string | null = null;
  private failureMeters?: TokenMeters;

  constructor(request: Request, private readonly signatures?: SignatureStore) {
    this.inner = new ChatResponseAssembly(request);
  }

  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    const chunk = payload as Shape;
    if (!chunk || typeof chunk !== 'object') throw new Error('Invalid Gemini chunk');
    if (chunk.error) throw new StreamErrorEvent(JSON.stringify(chunk.error));
    if (chunk.promptFeedback?.blockReason) throw new StreamErrorEvent(`Gemini blocked prompt: ${chunk.promptFeedback.blockReason}`);
    const candidate = (chunk.candidates ?? [])[0] as Shape | undefined;
    const usage = chatUsage(chunk.usageMetadata);
    if (!candidate) {
      if (usage) this.inner.feed({ usage, choices: [{ delta: {} }] }, emit);
      return;
    }
    if (typeof candidate.finishReason === 'string') {
      const reason = FINISH_REASONS[candidate.finishReason];
      if (!reason) {
        if (usage) this.failureMeters = chatMeters(usage);
        const message = `Gemini generation ended with ${candidate.finishReason}`;
        if (candidate.finishReason === 'MALFORMED_RESPONSE' || candidate.finishReason === 'MALFORMED_FUNCTION_CALL') {
          // Leave the recovery decision to the provider, after metering the failed stream.
          const id = typeof chunk.responseId === 'string' ? chunk.responseId : undefined;
          throw new GeminiMalformedResponse(message, this.meters(), id);
        }
        throw new StreamErrorEvent(message);
      }
      this.finishReason = reason;
    }
    const parts = (candidate.content?.parts ?? []) as Shape[];
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        this.inner.feed({ choices: [{ delta: part.thought === true ? { reasoning_content: part.text } : { content: part.text } }] }, emit);
      }
      if (part.functionCall) {
        const index = this.calls++;
        const id = `call_${index}_${crypto.randomUUID().slice(0, 8)}`;
        // Remember the signature under the id the framework will keep, so the next request can replay it.
        this.signatures?.set(id, part.thoughtSignature ?? part.functionCall?.thoughtSignature);
        this.inner.feed({
          choices: [{ delta: { tool_calls: [{ index, id,
            function: { name: String(part.functionCall.name ?? ''), arguments: JSON.stringify(part.functionCall.args ?? {}) } }] } }],
        }, emit);
      }
    }
    if (this.finishReason) {
      this.inner.feed({ ...(usage ? { usage } : {}), choices: [{ delta: {}, finish_reason: this.finishReason }] }, emit);
    }
  }

  finish(emit: (event: StreamEvent) => void): Response {
    // The wrapper salvages partial text as incomplete; disconnection is not a normal stop.
    if (!this.finishReason) throw new StreamErrorEvent('Gemini stream ended without finishReason');
    return this.inner.finish(emit);
  }

  snapshot(): Response | null { return this.inner.snapshot(); }
  meters(): TokenMeters { return this.failureMeters ?? this.inner.meters(); }
  serviceTier(): string | null { return this.inner.serviceTier(); }
}

export function parseGeminiResponse(raw: unknown, request: Request, signatures?: SignatureStore): { response: Response; meters: TokenMeters; serviceTier: string | null } {
  const assembler = new GeminiAssembly(request, signatures);
  const ignore = (() => {}) as unknown as (event: StreamEvent) => void;
  assembler.feed(raw, ignore);
  const response = assembler.finish(ignore);
  return { response, meters: assembler.meters(), serviceTier: assembler.serviceTier() };
}

export interface GeminiOptions extends RequestCredentials {
  baseUrl: string;
  log?: Logger;
  media?: CompatMediaOptions;
}

export class OpenCodeGemini extends OpenAIHttpClient {
  private readonly media?: CompatMediaOptions;
  private readonly identity: RequestIdentity;
  /** Survives across rounds: the registry reuses one instance per endpoint (registry.ts keeps a cache). */
  private readonly signatures = new SignatureStore();

  constructor(opts: GeminiOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.identity = new RequestIdentity(opts);
    this.media = opts.media;
  }

  /** The model and the method live in the path, so it is set per request before `respond` reads it. */
  override respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const method = options.onEvent ? 'streamGenerateContent?alt=sse' : 'generateContent';
    this.chatPath = `/models/${encodeURIComponent(request.model ?? '')}:${method}`;
    return this.identity.run(options.sessionId, () => super.respond(request, options));
  }

  protected override buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    return buildGeminiBody(request, options, this.media, this.signatures);
  }

  /** The body is built whole in `buildResponseBody`. */
  protected buildBody(): never {
    throw new Error('OpenCodeGemini does not build Chat Completions bodies');
  }

  protected override responseAssembly(request: Request): ResponseAssembly {
    return new GeminiAssembly(request, this.signatures);
  }

  protected override parseResponse(raw: unknown, request: Request): { response: Response; meters: TokenMeters; serviceTier: string | null } {
    try {
      return parseGeminiResponse(raw, request, this.signatures);
    } catch (error) {
      if (!(error instanceof GeminiMalformedResponse)) throw error;
      // The unary transport records meters from a parsed failed response before it retries.
      const response = createResponse(error.responseId ?? `resp_${crypto.randomUUID()}`, request);
      response.status = 'failed';
      response.error = { code: 'server_error', message: error.body };
      return { response, meters: error.meters, serviceTier: null };
    }
  }

  /** Gemini streams over SSE through `alt=sse`; there is no `stream` flag in the body. */
  protected override applyStreamFlags(): void {
    return;
  }

  protected override async onAuthError(): Promise<boolean> {
    return this.identity.keyRefused();
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.identity.headers(),
    };
  }
}
