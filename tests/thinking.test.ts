import { describe, expect, it } from 'vitest';
import { buildMessagesBody } from '../src/anthropic.ts';
import { buildGeminiBody } from '../src/gemini.ts';

/** A request carrying one user turn, shaped as the framework hands it to a dialect. */
function request(model: string): any {
  return {
    model,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    max_output_tokens: 256,
  };
}

/** `options` carries the spec the framework resolved from the endpoint's thinking settings. */
function options(thinking: boolean, reasoningEffort?: string): any {
  return { onEvent: () => {}, nativeSpec: { model: 'm', thinking, reasoningEffort, maxTokens: 256 } };
}

const messages = (thinking: boolean, effort?: string) => buildMessagesBody(request('claude-haiku-5-5'), options(thinking, effort)) as any;
const gemini = (thinking: boolean, effort?: string) => buildGeminiBody(request('gemini-4-argon'), options(thinking, effort)) as any;

describe('thinking settings reach the request', () => {
  it('stops Anthropic from thinking when the endpoint says off', () => {
    // Omitting the field does not stop it: the service then reasons on its own.
    expect(messages(false).thinking).toEqual({ type: 'disabled' });
    expect(messages(false).output_config).toBeUndefined();
  });

  it('sends Anthropic the adaptive form with the chosen effort, never the refused budget form', () => {
    for (const effort of ['low', 'medium', 'high']) {
      const body = messages(true, effort);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort });
      // Haiku 5.5 rejects `type: 'enabled'` and a budget outright.
      expect(body.thinking.budget_tokens).toBeUndefined();
    }
  });

  it('falls back to the default effort when thinking is on but no level was chosen', () => {
    expect(messages(true).output_config).toEqual({ effort: 'medium' });
  });

  it('sends Gemini a level, since this family refuses a budget', () => {
    const body = gemini(true, 'high');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
    expect(body.generationConfig.thinkingBudget).toBeUndefined();
  });

  it('uses the lowest Gemini level for off, because no level means no thinking', () => {
    expect(gemini(false).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });

  it('maps each effort to the enum Gemini accepts, defaulting anything unknown to medium', () => {
    expect(gemini(true, 'low').generationConfig.thinkingConfig.thinkingLevel).toBe('LOW');
    expect(gemini(true, 'medium').generationConfig.thinkingConfig.thinkingLevel).toBe('MEDIUM');
    expect(gemini(true, 'high').generationConfig.thinkingConfig.thinkingLevel).toBe('HIGH');
    // An unrecognised value would be refused as an invalid enum member.
    expect(gemini(true, 'extreme').generationConfig.thinkingConfig.thinkingLevel).toBe('MEDIUM');
    expect(gemini(true).generationConfig.thinkingConfig.thinkingLevel).toBe('MEDIUM');
  });

  it('keeps the Gemini level uppercase, which is the form the API names its values in', () => {
    for (const effort of ['low', 'medium', 'high']) {
      expect(gemini(true, effort).generationConfig.thinkingConfig.thinkingLevel).toBe(effort.toUpperCase());
    }
  });
});
