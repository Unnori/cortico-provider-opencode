/**
 * The Gemini API family, served at `<gateway>/[go/]google/v1beta/models/<model>:generateContent`, or
 * `:streamGenerateContent?alt=sse` when streaming. The method and the model are part of the path, so the
 * path is set per request; `super.respond` reads it before its first await, so concurrent requests
 * cannot observe each other's path.
 *
 * The key goes out both ways: OpenCode documents `Authorization: Bearer`, while the Gemini API itself
 * reads `x-goog-api-key`. Each side ignores the header it does not read.
 *
 * Like the other dialects the reply is translated into the Chat chunks the framework validates, so
 * items, tool calls, finish reasons and meters take the same path.
 */
import type { Logger } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { GenerateOptions, Generation, TokenMeters } from 'cortico/core/generation.ts';
import type { Request, Response, StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { ChatResponseAssembly, type ResponseAssembly } from 'cortico/providers/transport/response-assembly.ts';
import { StreamErrorEvent } from 'cortico/providers/transport/errors.ts';
import { renderMessagesWithMedia, type CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import { nativeChatInput, requestSpec, requestTools } from 'cortico/providers/transport/native-input.ts';
import { identityHeaders, newSession } from './identity.ts';

type Shape = Record<string, any>;
type Part = Record<string, unknown>;

const DEFAULT_MAX_TOKENS = 8192;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part === 'object' && (part as Shape).type === 'text'
    ? String((part as Shape).text ?? '') : '')).join('');
}

/** Text and inline image parts; Gemini takes bytes inline, base64 encoded. */
function partsOf(content: unknown): Part[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const part of content) {
    const value = part as Shape;
    if (value?.type === 'text' && typeof value.text === 'string' && value.text) parts.push({ text: value.text });
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
export function buildGeminiBody(request: Request, options: GenerateOptions, media?: CompatMediaOptions): Record<string, unknown> {
  const spec = requestSpec(request, options);
  const rendered = renderMessagesWithMedia(nativeChatInput(request, options), media) as Shape[];
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
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of rendered) {
    if (message.role === 'system') {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === 'assistant') {
      const parts = partsOf(message.content);
      for (const call of (message.tool_calls ?? []) as Shape[]) {
        parts.push({ functionCall: { name: call.function?.name, args: parseArguments(call.function?.arguments) } });
      }
      push('model', parts);
      continue;
    }
    if (message.role === 'tool') {
      const name = names.get(String(message.tool_call_id ?? '')) ?? 'tool';
      push('user', [{ functionResponse: { name, response: { result: textOf(message.content) } } }]);
      continue;
    }
    push('user', partsOf(message.content));
  }
  const body: Record<string, unknown> = { contents };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  const generationConfig: Record<string, unknown> = { maxOutputTokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS };
  if (spec.temperature !== undefined) generationConfig.temperature = spec.temperature;
  body.generationConfig = generationConfig;
  const tools = requestTools(request);
  if (tools?.length) body.tools = [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
  return body;
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
};

function chatUsage(raw: Shape | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const prompt = number(raw.promptTokenCount);
  const candidates = number(raw.candidatesTokenCount);
  const cached = number(raw.cachedContentTokenCount);
  return {
    ...(prompt === null ? {} : { prompt_tokens: prompt }),
    ...(candidates === null ? {} : { completion_tokens: candidates }),
    ...(prompt === null || candidates === null ? {} : { total_tokens: prompt + candidates }),
    ...(cached === null ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
  };
}

/** Gemini chunks translated into the Chat chunks `ChatResponseAssembly` validates. */
export class GeminiAssembly implements ResponseAssembly {
  private readonly inner: ChatResponseAssembly;
  private calls = 0;
  private finishReason: string | null = null;

  constructor(request: Request) {
    this.inner = new ChatResponseAssembly(request);
  }

  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    const chunk = payload as Shape;
    if (!chunk || typeof chunk !== 'object') throw new Error('Invalid Gemini chunk');
    if (chunk.error) throw new StreamErrorEvent(JSON.stringify(chunk.error));
    const candidate = (chunk.candidates ?? [])[0] as Shape | undefined;
    const usage = chatUsage(chunk.usageMetadata);
    if (!candidate) {
      if (usage) this.inner.feed({ usage, choices: [{ delta: {} }] }, emit);
      return;
    }
    if (typeof candidate.finishReason === 'string') this.finishReason = FINISH_REASONS[candidate.finishReason] ?? 'stop';
    const parts = (candidate.content?.parts ?? []) as Shape[];
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        this.inner.feed({ choices: [{ delta: part.thought === true ? { reasoning_content: part.text } : { content: part.text } }] }, emit);
      }
      if (part.functionCall) {
        const index = this.calls++;
        this.inner.feed({
          choices: [{ delta: { tool_calls: [{ index, id: `call_${index}_${crypto.randomUUID().slice(0, 8)}`,
            function: { name: String(part.functionCall.name ?? ''), arguments: JSON.stringify(part.functionCall.args ?? {}) } }] } }],
        }, emit);
      }
    }
    if (this.finishReason) {
      this.inner.feed({ ...(usage ? { usage } : {}), choices: [{ delta: {}, finish_reason: this.finishReason }] }, emit);
    }
  }

  finish(emit: (event: StreamEvent) => void): Response {
    // A stream can end without a candidate, so the terminal chunk is fed here when nothing closed it.
    if (!this.finishReason) this.inner.feed({ choices: [{ delta: {}, finish_reason: 'stop' }] }, emit);
    return this.inner.finish(emit);
  }

  snapshot(): Response | null { return this.inner.snapshot(); }
  meters(): TokenMeters { return this.inner.meters(); }
  serviceTier(): string | null { return this.inner.serviceTier(); }
}

export function parseGeminiResponse(raw: unknown, request: Request): { response: Response; meters: TokenMeters; serviceTier: string | null } {
  const assembler = new GeminiAssembly(request);
  const ignore = (() => {}) as unknown as (event: StreamEvent) => void;
  assembler.feed(raw, ignore);
  const response = assembler.finish(ignore);
  return { response, meters: assembler.meters(), serviceTier: assembler.serviceTier() };
}

export interface GeminiOptions {
  baseUrl: string;
  apiKey?: string;
  log?: Logger;
  media?: CompatMediaOptions;
}

export class OpenCodeGemini extends OpenAIHttpClient {
  private readonly apiKey?: string;
  private readonly media?: CompatMediaOptions;
  private session = '';
  private readonly fallback = newSession();

  constructor(opts: GeminiOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.apiKey = opts.apiKey;
    this.media = opts.media;
  }

  /** The model and the method live in the path, so it is set per request before `respond` reads it. */
  override respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const method = options.onEvent ? 'streamGenerateContent?alt=sse' : 'generateContent';
    this.chatPath = `/models/${encodeURIComponent(request.model ?? '')}:${method}`;
    return super.respond(request, options);
  }

  protected override buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    this.session = options.sessionId ?? '';
    return buildGeminiBody(request, options, this.media);
  }

  /** The body is built whole in `buildResponseBody`. */
  protected buildBody(): never {
    throw new Error('OpenCodeGemini does not build Chat Completions bodies');
  }

  protected override responseAssembly(request: Request): ResponseAssembly {
    return new GeminiAssembly(request);
  }

  protected override parseResponse(raw: unknown, request: Request): { response: Response; meters: TokenMeters; serviceTier: string | null } {
    return parseGeminiResponse(raw, request);
  }

  /** Gemini streams over SSE through `alt=sse`; there is no `stream` flag in the body. */
  protected override applyStreamFlags(): void {
    return;
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...identityHeaders(this.session || this.fallback),
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}`, 'x-goog-api-key': this.apiKey } : {}),
    };
  }
}
