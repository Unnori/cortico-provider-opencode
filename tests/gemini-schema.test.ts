import { describe, expect, it } from 'vitest';
import { geminiSchema } from '../src/gemini.ts';

/** Every keyword name in a schema tree, so a removal is asserted rather than spot-checked. */
function keywords(node: unknown, found = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    found.add(key);
    if (key === 'properties' && value && typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) keywords(child, found);
    } else if (key === 'items' || key === 'not') {
      if (Array.isArray(value)) value.forEach((item) => keywords(item, found));
      else keywords(value, found);
    } else if (Array.isArray(value)) {
      value.forEach((item) => keywords(item, found));
    }
  }
  return found;
}

describe('Gemini function schema', () => {
  it('drops the keyword the upstream refuses, at every level', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'notice', minLength: 1, maxLength: 240 },
        nested: { type: 'object', additionalProperties: { type: 'string' }, properties: { a: { type: 'string' } } },
        list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { b: { type: 'string' } } } },
      },
      required: ['text'],
    };
    const cleaned = geminiSchema(schema);
    // The refusal is about this one keyword appearing anywhere in the tree.
    expect(keywords(cleaned).has('additionalProperties')).toBe(false);
    expect(JSON.stringify(cleaned)).not.toContain('additionalProperties');
    // Everything Gemini does accept survives, so the model still sees the tool's shape.
    const survived = keywords(cleaned);
    for (const key of ['type', 'properties', 'required', 'items', 'description', 'minLength', 'maxLength']) {
      expect(survived.has(key)).toBe(true);
    }
    expect((cleaned as any).properties.nested.properties.a).toEqual({ type: 'string' });
    expect((cleaned as any).properties.list.items.properties.b).toEqual({ type: 'string' });
  });

  it('keeps the fields the real web_search tool relies on', () => {
    const webSearch = {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', minLength: 1, maxLength: 240, description: 'query' },
        mode: { type: 'string', enum: ['auto', 'answer', 'links'], default: 'auto' },
        n: { type: 'integer', minimum: 1, maximum: 6, default: 4 },
      },
      required: ['q'],
    };
    const cleaned = geminiSchema(webSearch) as any;
    expect(cleaned.required).toEqual(['q']);
    expect(Object.keys(cleaned.properties)).toEqual(['q', 'mode', 'n']);
    expect(cleaned.properties.n).toMatchObject({ type: 'integer', minimum: 1, maximum: 6, default: 4 });
    expect(cleaned.properties.mode.enum).toEqual(['auto', 'answer', 'links']);
  });

  it('gives an object schema a properties map, because a bare object is refused', () => {
    expect(geminiSchema({ type: 'object' })).toEqual({ type: 'object', properties: {} });
  });

  it('substitutes an object schema for anything unusable', () => {
    expect(geminiSchema(undefined)).toEqual({ type: 'object', properties: {} });
    expect(geminiSchema(null)).toEqual({ type: 'object', properties: {} });
    expect(geminiSchema([])).toEqual({ type: 'object', properties: {} });
    expect(geminiSchema('text')).toEqual({ type: 'object', properties: {} });
  });

  it('keeps union and array-of-object shapes usable', () => {
    const cleaned = geminiSchema({
      type: 'object',
      properties: {
        union: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        many: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } } } },
      },
    }) as any;
    expect(cleaned.properties.union.oneOf).toEqual([{ type: 'string' }, { type: 'number' }]);
    expect(cleaned.properties.many.items.properties.x).toEqual({ type: 'string' });
  });
});
