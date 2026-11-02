/**
 * Thought signatures, keyed by the tool-call id the framework keeps.
 *
 * Gemini 3 and later refuse a `functionCall` that comes back without the signature the model attached
 * to it: it is how the API detects a tool result that was tampered with. The framework's Chat-shaped
 * history keeps only `{ id, type, function }` on a tool call, so there is nowhere to carry the
 * signature — this client remembers it by call id instead, and replays it when the same call is
 * rebuilt into a request. The store is bounded because a long conversation never revisits old calls.
 */
export class SignatureStore {
  private readonly values = new Map<string, string>();

  constructor(private readonly limit = 4096) {}

  get(callId: string | undefined): string | undefined {
    if (!callId) return undefined;
    return this.values.get(callId);
  }

  /**
   * A call this process never received a signature for — restored from an earlier run, or picked up
   * from history written before signatures were kept. Gemini accepts this value and skips validation,
   * which is better than dropping the turn: without a signature at all the API answers 400.
   */
  static readonly SKIP = 'skip_thought_signature_validator';

  /** The signature to send for a call, falling back to the value that makes Gemini skip the check. */
  replay(callId: string | undefined): string {
    return this.get(callId) ?? SignatureStore.SKIP;
  }

  set(callId: string | undefined, signature: unknown): void {
    if (!callId || typeof signature !== 'string' || !signature) return;
    this.values.delete(callId);
    this.values.set(callId, signature);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next();
      if (oldest.done) break;
      this.values.delete(oldest.value);
    }
  }

  get size(): number {
    return this.values.size;
  }
}
