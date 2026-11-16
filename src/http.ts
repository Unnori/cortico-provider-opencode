/** Bounds the small auxiliary reads that do not use the framework's generation transport. */
export const AUXILIARY_TIMEOUT_MS = 20_000;

/** A caller's cancellation can shorten the deadline, never remove it. */
export function auxiliarySignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(AUXILIARY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** Native JSON parser errors may quote the response, including a credential reflected by a gateway. */
export function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON response`);
  }
}

/**
 * Count decoded response bytes while streaming, before retaining an unbounded body. Content-Length
 * is only an early rejection hint: chunked or compressed responses still need the byte counter.
 */
export async function readLimitedText(response: Response, maxBytes: number, label: string): Promise<string> {
  const tooLarge = (): Error => new Error(`${label}: response too large`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock();
  }
}
