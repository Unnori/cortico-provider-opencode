import { describe, expect, it } from 'vitest';
import { GenerationError } from 'cortico/core/generation.ts';
import { salvagePartial } from '../src/salvage.ts';

const origin = { instance: 'Opencode', module: 'opencode', model: 'gemini-4-argon', compatibilityDomain: 'x' };

/** A partial response carrying the given message text, shaped as the transport leaves it. */
function partialWith(text: string | null) {
  return {
    id: 'resp_1',
    status: 'in_progress',
    incomplete_details: null,
    model: 'gemini-4-argon',
    output: text === null
      ? []
      : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text }] }],
  } as never;
}

const errorWith = (partial: unknown): GenerationError =>
  new GenerationError('Chat transport ended without finish_reason', [], partial as never, origin as never, 0, '');

describe('salvaging a cut stream', () => {
  it('returns what the model already said, marked incomplete', () => {
    const salvaged = salvagePartial(errorWith(partialWith('卡了十分钟之后居然成功说了一句话')));
    expect(salvaged).not.toBeNull();
    expect(salvaged?.response.status).toBe('incomplete');
    expect(salvaged?.response.incomplete_details).toEqual({ reason: 'stream_interrupted' });
    const message = salvaged?.response.output.find((item) => item.type === 'message') as any;
    expect(message.content[0].text).toBe('卡了十分钟之后居然成功说了一句话');
  });

  it('keeps the origin and attempts so the run log still shows the failure', () => {
    const error = errorWith(partialWith('hi'));
    const salvaged = salvagePartial(error);
    expect(salvaged?.origin).toBe(error.origin);
    expect(salvaged?.attempts).toBe(error.attempts);
  });

  it('leaves a stream that produced nothing to fail, so it is retried', () => {
    expect(salvagePartial(errorWith(partialWith(null)))).toBeNull();
    expect(salvagePartial(errorWith(null))).toBeNull();
  });

  it('ignores an error that is not a generation failure', () => {
    expect(salvagePartial(new Error('boom'))).toBeNull();
    expect(salvagePartial(null)).toBeNull();
  });

  it('does not salvage an empty text part', () => {
    expect(salvagePartial(errorWith(partialWith('')))).toBeNull();
  });
});
