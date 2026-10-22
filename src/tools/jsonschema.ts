/**
 * Validator for the JSON Schema subset WebMorph generates: objects with
 * typed properties, required lists, enums, string patterns, integer bounds,
 * arrays of objects. Returns human-readable problems instead of throwing.
 */
export interface SchemaProblem {
  path: string;
  message: string;
}

type Schema = Record<string, unknown>;

export function validateAgainstSchema(schema: Schema, value: unknown, path = '$'): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const type = schema['type'];
  const types = Array.isArray(type) ? (type as string[]) : type ? [type as string] : [];

  if (types.length && !types.some((t) => matchesType(t, value))) {
    problems.push({ path, message: `expected ${types.join(' or ')}, got ${describe(value)}` });
    return problems;
  }
  if (Array.isArray(schema['enum']) && !(schema['enum'] as unknown[]).some((v) => v === value)) {
    problems.push({ path, message: `must be one of ${JSON.stringify(schema['enum'])}` });
  }
  if (typeof value === 'string') {
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern']).test(value)) problems.push({ path, message: `does not match ${schema['pattern']}` });
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) problems.push({ path, message: `shorter than ${schema['minLength']}` });
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) problems.push({ path, message: `longer than ${schema['maxLength']}` });
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) problems.push({ path, message: `below minimum ${schema['minimum']}` });
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) problems.push({ path, message: `above maximum ${schema['maximum']}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) problems.push({ path, message: `fewer than ${schema['minItems']} items` });
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) problems.push({ path, message: `more than ${schema['maxItems']} items` });
    const items = schema['items'];
    if (items && typeof items === 'object') value.forEach((item, i) => problems.push(...validateAgainstSchema(items as Schema, item, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema['properties'] ?? {}) as Record<string, Schema>;
    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (obj[key] === undefined) problems.push({ path: `${path}.${key}`, message: 'is required' });
    }
    for (const [key, sub] of Object.entries(props)) {
      if (obj[key] !== undefined) problems.push(...validateAgainstSchema(sub, obj[key], `${path}.${key}`));
    }
    if (schema['additionalProperties'] === false) {
      for (const key of Object.keys(obj)) if (!(key in props)) problems.push({ path: `${path}.${key}`, message: 'is not an allowed property' });
    }
  }
  return problems;
}

function matchesType(t: string, v: unknown): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null':
      return v === null;
    default:
      return true;
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
