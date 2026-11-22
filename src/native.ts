/**
 * The three dialects OpenCode serves, over the framework's HTTP/SSE transport. Console translates every
 * text model to whichever API it is asked on, so the protocol option only decides the request shape.
 *
 * Both OpenAI dialects name themselves in User-Agent and carry the conversation id in
 * `x-opencode-session`; OpenCode asks clients to identify themselves and to send a stable session id for
 * routing and prompt caching. Reasoning goes back as plain text rather than signed blocks, because a
 * gateway that forwards to other providers cannot be assumed to round-trip an encrypted reasoning item.
 */
import type { Logger, ModelSpec, ToolSchema } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { GenerateOptions, Generation } from 'cortico/core/generation.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { BaseProvider } from 'cortico/providers/base.ts';
import { buildResponsesBody, ResponsesProvider, type ResponsesProviderOptions } from 'cortico/providers/openai-responses-compat/native.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { retryDelay } from 'cortico/providers/transport/errors.ts';
import { mapTools, renderMessagesWithMedia, type CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import type { NativeChatMessage } from 'cortico/providers/transport/native-types.ts';
import type { Protocol } from './address.ts';
import { OpenCodeMessages } from './anthropic.ts';
import { GeminiMalformedResponse, incompleteGeminiResponse, OpenCodeGemini } from './gemini.ts';
import { RequestIdentity, type RequestCredentials } from './identity.ts';
import { DEFAULT_EFFORT } from './options.ts';
import type { LocalSpend } from './usage.ts';
import { GenerationError } from 'cortico/core/generation.ts';
import { chatMediaParts, prepareAttachments, type AttachmentPolicy } from './attachments.ts';
import { applyGatewayMeters } from './meters.ts';
import { salvagePartial } from './salvage.ts';
import { chatImageCount, mediaForRequest, requestImageCount, sanitizeNativeImages } from './images.ts';
import { chatToolMedia } from './protocol-contract.ts';

export { USER_AGENT } from './identity.ts';
export { OpenCodeMessages, OpenCodeGemini };

export interface ClientOptions extends RequestCredentials {
  baseUrl: string;
  log?: Logger;
  media?: CompatMediaOptions;
}

/** Chat Completions with the gateway identity scoped to each request. */
export class OpenCodeChat extends OpenAIHttpClient {
  private readonly media?: CompatMediaOptions;
  private readonly identity: RequestIdentity;

  constructor(opts: ClientOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.identity = new RequestIdentity(opts);
    this.media = opts.media;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  /**
   * The framework asks this after 401/403; answering true makes it retry once, which is how a refused
   * key hands the attempt to the next one instead of failing the turn.
   */
  protected override async onAuthError(): Promise<boolean> {
    return this.identity.keyRefused();
  }

  override respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    return this.identity.run(options.sessionId, () => super.respond(request, options));
  }

  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: spec.model,
      messages: chatToolMedia(chatMediaParts(renderMessagesWithMedia(messages, mediaForRequest(this.media, chatImageCount(messages))))),
    };
    // Leaving the field out does not mean off: the service then reasons on its own (85 reasoning tokens
    // measured on a plain question). `none` is what stops it.
    body.reasoning_effort = spec.thinking ? spec.reasoningEffort ?? DEFAULT_EFFORT : 'none';
    if (spec.temperature !== undefined) body.temperature = spec.temperature;
    if (spec.maxTokens !== undefined) body.max_tokens = spec.maxTokens;
    const mapped = mapTools(tools);
    if (mapped) body.tools = mapped;
    return body;
  }

  protected headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...this.identity.headers() };
  }
}

/** Native Responses, with the same identity headers. */
export class OpenCodeResponses extends ResponsesProvider {
  private readonly identity: RequestIdentity;
  private readonly responseOptions: ResponsesProviderOptions;

  constructor(opts: ResponsesProviderOptions & RequestCredentials) {
    super({ ...opts, apiKey: undefined });
    this.responseOptions = opts;
    this.identity = new RequestIdentity(opts);
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  /** Answering true makes the framework retry once, with the next key in the header. */
  protected override async onAuthError(): Promise<boolean> {
    return this.identity.keyRefused();
  }

  override respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    return this.identity.run(options.sessionId, () => super.respond(request, options));
  }

  protected override buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    const opts = this.responseOptions;
    return buildResponsesBody(request, options, {
      media: mediaForRequest(opts.media, requestImageCount(request, options)),
      keepThinking: opts.keepThinking, reasoningReplay: opts.reasoningReplay,
      syntheticReasoningText: opts.syntheticReasoningText, sendSyntheticReasoning: opts.sendSyntheticReasoning,
    }, opts.extraBody);
  }

  protected override headers(): Record<string, string> {
    return { ...super.headers(), ...this.identity.headers() };
  }
}

/**
 * Dollars this process spent per model, so the allowance bars can move between the gateway's reads.
 * Go's equivalent USD charges track allowance consumption. A charge whose amount is unknown
 * contributes nothing rather than a guess.
 */
export class SpendLedger {
  private readonly byModel = new Map<string, number>();

  add(model: string, usd: number): void {
    if (!model || !Number.isFinite(usd) || usd <= 0) return;
    this.byModel.set(model, (this.byModel.get(model) ?? 0) + usd);
  }

  snapshot(): LocalSpend {
    return Object.fromEntries(this.byModel);
  }

  clear(): void {
    this.byModel.clear();
  }
}

export interface ProviderOptions extends ClientOptions {
  protocol: Protocol;
  keepThinking: () => boolean;
  attachments?: (model: string) => AttachmentPolicy;
  ledger?: SpendLedger;
}

/** One endpoint: the protocol picks the client, and every finished generation feeds the local ledger. */
export class OpenCodeProvider extends BaseProvider {
  private readonly client: OpenCodeChat | OpenCodeResponses | OpenCodeMessages | OpenCodeGemini;
  private readonly ledger?: SpendLedger;
  private readonly attachmentPolicy?: (model: string) => AttachmentPolicy;
  private readonly rejected = new Map<string, Set<string>>();
  private readonly log: Logger;
  private readonly media?: CompatMediaOptions;

  constructor(opts: ProviderOptions) {
    super();
    this.ledger = opts.ledger;
    this.log = opts.log ?? nullLogger();
    this.attachmentPolicy = opts.attachments;
    this.media = opts.media;
    const shared = {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      keyCursor: opts.keyCursor,
      log: opts.log,
      media: opts.media,
    };
    this.client = opts.protocol === 'anthropic'
      ? new OpenCodeMessages(shared)
      : opts.protocol === 'gemini'
        ? new OpenCodeGemini(shared)
        : opts.protocol === 'chat'
          ? new OpenCodeChat(shared)
          : new OpenCodeResponses({ ...shared, keepThinking: opts.keepThinking, reasoningReplay: 'encrypted' });
  }

  override async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const original = options;
    const policy = this.attachmentPolicy?.(request.model ?? '');
    const rejected = this.rejected.get(request.model ?? '') ?? new Set<string>();
    const recoverGemini = this.client instanceof OpenCodeGemini && options.onEvent && !options.diagnostic;
    const prepared = policy ? prepareAttachments(request, options, { ...policy, rejected }) : undefined;
    options = prepared?.options ?? sanitizeNativeImages(request, options, this.media);
    try {
      return await this.send(request, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (recoverGemini && error instanceof GenerationError && error.cause instanceof GeminiMalformedResponse) {
        if (error.partial?.output.length) return incompleteGeminiResponse(request, error, error.cause);
        const textOnly = Boolean(policy && prepared?.hashes.length);
        const fallback = textOnly && policy ? prepareAttachments(request, original, policy, true).options : options;
        this.log.warn('opencode: retrying malformed Gemini response', { model: request.model, textOnly, delayMs: 1000 });
        return this.retry(request, fallback, error, true, 1000);
      }
      if (policy && prepared?.hashes.length && error instanceof GenerationError
        && [400, 415, 422].includes(error.status) && !error.partial?.output?.length
        && /(?:image|audio|video|media|mime|file|document).{0,100}(?:unsupported|not supported|invalid|format)|(?:unsupported|invalid).{0,100}(?:image|audio|video|media|mime|file|document)|400102/i.test(error.body + ' ' + error.message)) {
        for (const hash of prepared.hashes) rejected.add(hash);
        while (rejected.size > 512) rejected.delete(rejected.values().next().value!);
        this.rejected.delete(request.model ?? '');
        this.rejected.set(request.model ?? '', rejected);
        while (this.rejected.size > 32) this.rejected.delete(this.rejected.keys().next().value!);
        policy.dropped?.('upstream rejected media; retrying with text', 'batch');
        const fallback = prepareAttachments(request, original, policy, true).options;
        return this.retry(request, fallback, error, Boolean(recoverGemini));
      }
      // A stream cut after it produced text would otherwise be retried from scratch, and an upstream
      // that cuts at the same point every time turns one answer into a long silence.
      const salvaged = salvagePartial(error);
      if (!salvaged) throw error;
      return salvaged;
    }
  }

  private async retry(request: Request, options: GenerateOptions, first: GenerationError, recoverGemini: boolean, delayMs = 0): Promise<Generation> {
    if (delayMs) {
      try {
        await retryDelay(delayMs, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw new GenerationError('OpenCode retry cancelled', first.attempts,
          first.partial, first.origin, 0, '', { cause: error });
        throw error;
      }
    }
    try {
      const retried = await this.send(request, options);
      return { ...retried, attempts: [...first.attempts, ...retried.attempts] };
    } catch (error) {
      if (!(error instanceof GenerationError)) throw error;
      const combined = new GenerationError(error.message, [...first.attempts, ...error.attempts],
        error.partial, error.origin, error.status, error.body, { cause: error.cause });
      if (recoverGemini && !options.signal?.aborted && error.cause instanceof GeminiMalformedResponse) {
        return incompleteGeminiResponse(request, combined, error.cause);
      }
      throw combined;
    }
  }

  private async send(request: Request, options: GenerateOptions): Promise<Generation> {
    let generation: Generation;
    try {
      generation = await this.client.respond(request, options);
    } catch (error) {
      if (error instanceof GenerationError) {
        if (error.cause instanceof GeminiMalformedResponse) {
          const attempt = error.attempts.at(-1);
          if (attempt && error.cause.responseId) attempt.responseId = error.cause.responseId;
          this.log.warn('opencode: malformed Gemini response', {
            model: request.model, reason: error.cause.body, responseId: error.cause.responseId,
          });
        }
        this.record(request, error, options);
      }
      throw error;
    }
    this.record(request, generation, options);
    return generation;
  }

  private record(request: Request, generation: Pick<Generation, 'attempts'>, options: GenerateOptions): void {
    const mediaTypes = new Set<string>();
    for (const entry of options.context ?? []) {
      const item = entry.item;
      const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (part.type === 'input_image') mediaTypes.add('image');
        if (part.type === 'input_file' && 'file_data' in part && part.file_data) {
          const match = /^data:(audio|video)\//.exec(part.file_data);
          if (match) mediaTypes.add(match[1]);
        }
      }
    }
    applyGatewayMeters(generation, mediaTypes);
    if (!this.ledger) return;
    const model = request.model ?? '';
    let usd = 0;
    let known = false;
    for (const attempt of generation.attempts) {
      // A Go request can fall back to Console credit without using any Go allowance.
      const native = attempt.meters.native as { opencode?: { billing_source?: string } } | null;
      if (native?.opencode?.billing_source === 'balance') continue;
      for (const charge of attempt.charges ?? []) {
        if (charge.quote.basis !== 'equivalent' || charge.quote.currency !== 'USD' || charge.amount === null) continue;
        usd += charge.amount;
        known = true;
      }
    }
    if (known) this.ledger.add(model, usd);
  }
}
