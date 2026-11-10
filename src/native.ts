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
import { ResponsesProvider, type ResponsesProviderOptions } from 'cortico/providers/openai-responses-compat/native.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { mapTools, renderMessagesWithMedia, type CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import type { NativeChatMessage } from 'cortico/providers/transport/native-types.ts';
import type { Protocol } from './address.ts';
import { OpenCodeMessages } from './anthropic.ts';
import { OpenCodeGemini } from './gemini.ts';
import { identityHeaders, newSession } from './identity.ts';
import { DEFAULT_EFFORT } from './options.ts';
import type { LocalSpend } from './usage.ts';
import { salvagePartial } from './salvage.ts';

export { USER_AGENT } from './identity.ts';
export { OpenCodeMessages, OpenCodeGemini };

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Read per attempt so a refused key can be swapped for the next one; takes precedence over `apiKey`. */
  apiKeyOf?: () => string | undefined;
  onKeyRefused?: () => void;
  log?: Logger;
  media?: CompatMediaOptions;
}

/**
 * Chat Completions. The session id arrives with each request body; `headers` runs right after it in the
 * same attempt, so the field carries the id across. A concurrent request on the same endpoint can
 * overwrite it, which costs nothing more than a routing hint.
 */
export class OpenCodeChat extends OpenAIHttpClient {
  private readonly apiKey?: string;
  private readonly apiKeyOf?: () => string | undefined;
  private readonly onKeyRefused?: () => void;
  private readonly media?: CompatMediaOptions;
  private session = '';
  /** The probe carries no conversation id, and the gateway refuses a request without one. */
  private readonly fallback = newSession();

  constructor(opts: ClientOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.apiKey = opts.apiKey;
    this.apiKeyOf = opts.apiKeyOf;
    this.onKeyRefused = opts.onKeyRefused;
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
    if (!this.onKeyRefused || !this.apiKeyOf) return false;
    this.onKeyRefused();
    return true;
  }

  /** The key for this attempt, so rotation happens between transport attempts rather than per request. */
  protected key(): string | undefined {
    return this.apiKeyOf?.() ?? this.apiKey;
  }

  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[], sessionId?: string): Record<string, unknown> {
    this.session = sessionId ?? '';
    const body: Record<string, unknown> = {
      model: spec.model,
      messages: renderMessagesWithMedia(messages, this.media),
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
    const key = this.key();
    return {
      'Content-Type': 'application/json',
      ...identityHeaders(this.session || this.fallback),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
  }
}

/** Native Responses, with the same identity headers. */
export class OpenCodeResponses extends ResponsesProvider {
  private session = '';
  private readonly fallback = newSession();
  private readonly apiKeyOf?: () => string | undefined;
  private readonly onKeyRefused?: () => void;

  constructor(opts: ResponsesProviderOptions & { apiKeyOf?: () => string | undefined; onKeyRefused?: () => void }) {
    super(opts);
    this.apiKeyOf = opts.apiKeyOf;
    this.onKeyRefused = opts.onKeyRefused;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  /** Answering true makes the framework retry once, with the next key in the header. */
  protected override async onAuthError(): Promise<boolean> {
    if (!this.onKeyRefused || !this.apiKeyOf) return false;
    this.onKeyRefused();
    return true;
  }

  protected override buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    this.session = options.sessionId ?? '';
    return super.buildResponseBody(request, options);
  }

  protected override headers(): Record<string, string> {
    // The parent builds the API key header from its own copy of the options, so the key this client may
    // rotate has to replace it here rather than be inherited.
    const inherited = super.headers();
    const key = this.apiKeyOf?.();
    const withKey = key ? { ...inherited, Authorization: `Bearer ${key}` } : inherited;
    return {
      ...withKey,
      ...identityHeaders(this.session || this.fallback),
    };
  }
}

/**
 * Dollars this process spent per model, so the allowance bars can move between the gateway's reads.
 * The transport already prices each attempt against the endpoint's quote, so the sum of those charges
 * is the figure; an attempt whose charge is unknown contributes nothing rather than a guess.
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
  ledger?: SpendLedger;
  /** Called when the account refuses the key in use, so the next attempt uses the following one. */
  onKeyRefused?: () => void;
}

/** One endpoint: the protocol picks the client, and every finished generation feeds the local ledger. */
export class OpenCodeProvider extends BaseProvider {
  private readonly client: OpenCodeChat | OpenCodeResponses | OpenCodeMessages | OpenCodeGemini;
  private readonly ledger?: SpendLedger;

  constructor(opts: ProviderOptions) {
    super();
    this.ledger = opts.ledger;
    const shared = {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      apiKeyOf: opts.apiKeyOf,
      log: opts.log,
      media: opts.media,
      onKeyRefused: opts.onKeyRefused,
    };
    this.client = opts.protocol === 'anthropic'
      ? new OpenCodeMessages(shared)
      : opts.protocol === 'gemini'
        ? new OpenCodeGemini(shared)
        : opts.protocol === 'chat'
          ? new OpenCodeChat(shared)
          : new OpenCodeResponses({ ...shared, keepThinking: opts.keepThinking, reasoningReplay: 'plaintext' });
  }

  override async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    try {
      const generation = await this.client.respond(request, options);
      this.record(request, generation);
      return generation;
    } catch (error) {
      // A stream cut after it produced text would otherwise be retried from scratch, and an upstream
      // that cuts at the same point every time turns one answer into a long silence.
      const salvaged = salvagePartial(error);
      if (!salvaged) throw error;
      this.record(request, salvaged);
      return salvaged;
    }
  }

  private record(request: Request, generation: Generation): void {
    if (!this.ledger) return;
    const model = request.model ?? '';
    let usd = 0;
    let known = false;
    for (const attempt of generation.attempts) {
      for (const charge of attempt.charges ?? []) {
        if (charge.amount === null) continue;
        usd += charge.amount;
        known = true;
      }
    }
    if (known) this.ledger.add(model, usd);
  }
}
