import { QUERY_DENYLIST } from './redact.js';

const DENY = new RegExp(`(${QUERY_DENYLIST.join('|')})`, 'i');

export interface GraphQLRequestInfo {
  operationName?: string;
  operationType: 'query' | 'mutation' | 'subscription' | 'unknown';
  query: string;
  variables?: Record<string, unknown>;
  variableNames: string[];
}

/** Parse a request body as a GraphQL request (single or batched). Returns null when it is not one. */
export function parseGraphQLRequest(contentType: string | undefined, body: string | null | undefined): GraphQLRequestInfo[] | null {
  if (!body || !/json/i.test(contentType ?? '')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out: GraphQLRequestInfo[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj['query'] !== 'string') return null;
    const query = obj['query'];
    const stripped = query.replace(/#[^\n]*/g, '').trim();
    const m = stripped.match(/^(query|mutation|subscription)\b\s*([A-Za-z_][A-Za-z0-9_]*)?/);
    const operationType: GraphQLRequestInfo['operationType'] = m ? (m[1] as GraphQLRequestInfo['operationType']) : stripped.startsWith('{') || stripped.startsWith('fragment') ? 'query' : 'unknown';
    const variables = obj['variables'] && typeof obj['variables'] === 'object' && !Array.isArray(obj['variables']) ? (obj['variables'] as Record<string, unknown>) : undefined;
    out.push({
      operationName: typeof obj['operationName'] === 'string' ? obj['operationName'] : m?.[2],
      operationType,
      query: query.slice(0, 4000),
      ...(variables ? { variables: redactVariables(variables) } : {}),
      variableNames: variables ? Object.keys(variables).slice(0, 40) : [],
    });
  }
  return out;
}

/** True when every operation in the request is a query (never a mutation or subscription). */
export function isGraphQLReadOnly(info: GraphQLRequestInfo[] | null): boolean {
  return Boolean(info && info.length > 0 && info.every((i) => i.operationType === 'query'));
}

/** Variables with sensitive-looking keys replaced and long strings truncated. Depth-limited. */
export function redactVariables(value: unknown, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!value || typeof value !== 'object' || depth > 4) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
    if (DENY.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'string') out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === 'object' && x ? redactVariables(x, depth + 1) : typeof x === 'string' ? x.slice(0, 200) : x));
    else if (v && typeof v === 'object') out[k] = redactVariables(v, depth + 1);
    else out[k] = v;
  }
  return out;
}

export interface GraphQLVariableDecl {
  name: string;
  type: string;
  required: boolean;
  /** JSON-ish kind for inputs; undefined for input object types that are not promoted. */
  kind?: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  items?: 'string' | 'integer' | 'number';
}

/** Variable declarations of the first operation in a query document: query Search($search: String!, $cities: [String]) ... */
export function parseGraphQLVariables(query: string): GraphQLVariableDecl[] {
  const m = query.replace(/#[^\n]*/g, '').match(/^\s*(?:query|mutation|subscription)\s*[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/);
  if (!m) return [];
  const out: GraphQLVariableDecl[] = [];
  for (const part of m[1]!.split(',')) {
    const d = part.trim().match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=]+?)(?:\s*=\s*.+)?$/);
    if (!d) continue;
    const type = d[2]!.trim();
    const required = type.endsWith('!');
    const bare = type.replace(/!/g, '');
    const list = bare.match(/^\[(.+)\]$/);
    const scalar = (t: string): 'string' | 'integer' | 'number' | 'boolean' | undefined => (t === 'String' || t === 'ID' ? 'string' : t === 'Int' ? 'integer' : t === 'Float' ? 'number' : t === 'Boolean' ? 'boolean' : undefined);
    if (list) {
      const item = scalar(list[1]!);
      out.push({ name: d[1]!, type, required, ...(item && item !== 'boolean' ? { kind: 'array', items: item } : {}) });
    } else {
      const k = scalar(bare);
      out.push({ name: d[1]!, type, required, ...(k ? { kind: k } : {}) });
    }
  }
  return out;
}
