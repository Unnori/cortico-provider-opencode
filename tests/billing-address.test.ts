import { describe, expect, it } from 'vitest';
import { billingHintOf, modelListUrl, parseGateway } from '../src/address.ts';
import { billingOf, DEFAULT_BILLING } from '../src/options.ts';

const entryWith = (baseUrl: string, billing?: string): any => ({
  kind: 'opencode',
  baseUrl,
  secret: 'K',
  ...(billing ? { options: { billing } } : {}),
});

describe('the address decides the account when the option is unset', () => {
  it('reads a family path without /go as the balance account', () => {
    // Pasting a balance address used to reach the subscription and show its models instead.
    expect(billingHintOf('https://opencode.ai/inference/openai/v1')).toBe('balance');
    expect(billingHintOf('https://opencode.ai/inference/anthropic/v1')).toBe('balance');
    expect(billingHintOf('https://opencode.ai/inference/google/v1beta')).toBe('balance');
    expect(billingHintOf('https://opencode.ai/inference/v1/models')).toBe('balance');
  });

  it('reads a /go path as the subscription', () => {
    expect(billingHintOf('https://opencode.ai/inference/go/openai/v1')).toBe('go');
    expect(billingHintOf('https://opencode.ai/inference/go/v1/models')).toBe('go');
  });

  it('says nothing for a bare gateway root or a foreign host', () => {
    expect(billingHintOf('https://opencode.ai/inference')).toBeNull();
    expect(billingHintOf('https://opencode.ai/inference/')).toBeNull();
    expect(billingHintOf('https://my-proxy.example.com/v1')).toBeNull();
  });

  it('lets an explicit option win over the address', () => {
    expect(billingOf(entryWith('https://opencode.ai/inference/openai/v1', 'go'))).toBe('go');
    expect(billingOf(entryWith('https://opencode.ai/inference/go/openai/v1', 'balance'))).toBe('balance');
  });

  it('follows the address when the option is unset, and the default for a bare root', () => {
    expect(billingOf(entryWith('https://opencode.ai/inference/openai/v1'))).toBe('balance');
    expect(billingOf(entryWith('https://opencode.ai/inference/go/openai/v1'))).toBe('go');
    expect(billingOf(entryWith('https://opencode.ai/inference'))).toBe(DEFAULT_BILLING);
    expect(billingOf(entryWith('https://my-proxy.example.com/v1'))).toBe(DEFAULT_BILLING);
  });

  it('asks for the model list the inferred account owns', () => {
    const balance = parseGateway('https://opencode.ai/inference/openai/v1')!;
    const go = parseGateway('https://opencode.ai/inference/go/openai/v1')!;
    expect(modelListUrl(balance, billingOf(entryWith('https://opencode.ai/inference/openai/v1'))))
      .toBe('https://opencode.ai/inference/v1/models');
    expect(modelListUrl(go, billingOf(entryWith('https://opencode.ai/inference/go/openai/v1'))))
      .toBe('https://opencode.ai/inference/go/v1/models');
  });
});
