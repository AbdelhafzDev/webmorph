import { describe, expect, it } from 'vitest';
import { validateAgainstSchema } from '../src/tools/jsonschema.js';

const schema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    page: { type: 'integer', minimum: 1 },
    sort: { type: 'string', enum: ['asc', 'desc'] },
    results: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] } },
  },
  required: ['query'],
  additionalProperties: false,
};

describe('validateAgainstSchema', () => {
  it('accepts valid input', () => {
    expect(validateAgainstSchema(schema, { query: 'shoes', page: 2, sort: 'desc', results: [{ title: 'a', url: 'b' }] })).toEqual([]);
  });
  it('reports missing required, wrong types, enum and bounds violations', () => {
    const problems = validateAgainstSchema(schema, { page: 0, sort: 'sideways', results: [{ title: 1 }], extra: true });
    const messages = problems.map((p) => `${p.path} ${p.message}`);
    expect(messages).toContain('$.query is required');
    expect(messages).toContain('$.page below minimum 1');
    expect(messages).toContain('$.sort must be one of ["asc","desc"]');
    expect(messages).toContain('$.results[0].title expected string, got number');
    expect(messages).toContain('$.results[0].url is required');
    expect(messages).toContain('$.extra is not an allowed property');
  });
  it('distinguishes integers from numbers', () => {
    expect(validateAgainstSchema({ type: 'integer' }, 1.5)).toHaveLength(1);
    expect(validateAgainstSchema({ type: 'number' }, 1.5)).toEqual([]);
  });
});
