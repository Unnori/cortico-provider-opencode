/**
 * Salvage a generation whose stream broke after it had already produced output.
 *
 * `generate()` keeps the partial snapshot on the error and refuses to retry once text has gone out
 * (`committed`), but nothing upstream reads the snapshot: the turn fails and the text the operator
 * already saw is thrown away. Returning it as an `incomplete` response keeps the answer and lets the
 * next turn continue from it.
 *
 * Only a stream that carried text is salvaged. One that produced nothing is a real failure and must
 * keep its retry, because there is nothing to show.
 */
import { GenerationError, type Generation } from 'cortico/core/generation.ts';

type PartialResponse = NonNullable<GenerationError['partial']>;

/** The text a partial response already produced, if any. */
function producedText(partial: PartialResponse): string {
  const output = (partial as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }).output;
  if (!Array.isArray(output)) return '';
  let text = '';
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
    }
  }
  return text;
}

/**
 * The generation to return instead of throwing, or null when nothing usable was produced.
 *
 * `reason` says the stream stopped early rather than the output limit being reached, so the two cases
 * stay distinguishable in the run log.
 */
export function salvagePartial(error: unknown): Generation | null {
  if (!(error instanceof GenerationError)) return null;
  if (!error.partial || !producedText(error.partial)) return null;
  return {
    response: { ...error.partial, status: 'incomplete', incomplete_details: { reason: 'stream_interrupted' } },
    origin: error.origin,
    attempts: error.attempts,
  } as Generation;
}
