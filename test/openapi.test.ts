import { describe, expect, it } from 'vitest';
import { matchesDocumentedPath, parseOpenApi } from '../src/docs/openapi.js';
import { parseLlmsTxt } from '../src/docs/llms.js';
import { cookieNames, isCredentialed, redactUrl, shapeOfJson } from '../src/net/redact.js';
import { parseGraphQLRequest, parseGraphQLVariables, isGraphQLReadOnly } from '../src/net/graphql.js';

describe('parseOpenApi', () => {
  it('parses OpenAPI 3 with refs, servers and security', () => {
    const spec = parseOpenApi(JSON.stringify({
      openapi: '3.1.0', info: { title: 'T', version: '2' },
      servers: [{ url: 'https://{env}.api.test/v1', variables: { env: { default: 'prod' } } }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, parameters: { Q: { name: 'q', in: 'query', schema: { type: 'string' } } }, schemas: { Item: { type: 'object', properties: { id: {}, name: {} } } } },
      security: [{ bearer: [] }],
      paths: {
        '/items': { get: { operationId: 'listItems', security: [], parameters: [{ $ref: '#/components/parameters/Q' }], responses: { '200': { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Item' } } } } } } }, post: { operationId: 'createItem', requestBody: { content: {} }, responses: {} } },
        '/items/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } } } },
      },
    }), 'https://api.test/openapi.json')!;
    expect(spec.format).toBe('openapi3');
    expect(spec.servers).toEqual(['https://prod.api.test/v1']);
    const list = spec.operations.find((o) => o.operationId === 'listItems')!;
    expect(list).toMatchObject({ method: 'get', path: '/items', authRequired: false, sideEffectClass: 'read', responseIsArray: true, responseKeys: ['id', 'name'] });
    expect(list.parameters[0]).toMatchObject({ name: 'q', in: 'query', required: false, type: 'string' });
    const create = spec.operations.find((o) => o.operationId === 'createItem')!;
    expect(create).toMatchObject({ authRequired: true, securitySchemes: ['bearer'], sideEffectClass: 'write', hasRequestBody: true });
    const detail = spec.operations.find((o) => o.path === '/items/{id}')!;
    expect(detail.operationId).toBe('get_items_id');
    expect(detail.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(detail.authRequired).toBe(true);
  });
  it('parses Swagger 2 in YAML and rejects non-specs', () => {
    const spec = parseOpenApi('swagger: "2.0"\ninfo: {title: S, version: "1"}\nhost: s.test\nbasePath: /v2\nschemes: [https]\npaths:\n  /things:\n    get:\n      produces: [application/json]\n      responses:\n        200:\n          schema: {type: array, items: {type: object, properties: {a: {}}}}\n', 'https://s.test/swagger.yaml')!;
    expect(spec.format).toBe('swagger2');
    expect(spec.servers).toEqual(['https://s.test/v2']);
    expect(spec.operations[0]).toMatchObject({ path: '/things', responseIsArray: true, responseKeys: ['a'], responseContentTypes: ['application/json'] });
    expect(parseOpenApi('{"hello":"world"}', 'https://x.test/a.json')).toBeNull();
    expect(parseOpenApi('<html>', 'https://x.test/a.json')).toBeNull();
  });
  it('matches concrete paths against templates', () => {
    expect(matchesDocumentedPath('/products/42', '/products/{id}')).toBe(true);
    expect(matchesDocumentedPath('/products/42/reviews', '/products/{id}')).toBe(false);
    expect(matchesDocumentedPath('/products', '/products')).toBe(true);
  });
});

describe('parseLlmsTxt', () => {
  it('reads title, summary, sections and links', () => {
    const parsed = parseLlmsTxt('# Shop\n\n> A shop.\n\n## Docs\n- [Intro](/docs/intro): Start here\n- [API](https://shop.test/openapi.json)\n\n## Other\n- [Blog](/blog)\n', 'https://shop.test/llms.txt');
    expect(parsed.title).toBe('Shop');
    expect(parsed.summary).toBe('A shop.');
    expect(parsed.sections.map((s) => s.heading)).toEqual(['Docs', 'Other']);
    expect(parsed.sections[0]!.links[0]).toEqual({ title: 'Intro', url: 'https://shop.test/docs/intro', note: 'Start here' });
  });
});

describe('redaction', () => {
  it('redacts sensitive query values and strips credentials from URLs', () => {
    expect(redactUrl('https://a.test/x?q=shoes&token=abc&api_key=k&page=2')).toBe('https://a.test/x?q=shoes&token=%5Bredacted%5D&api_key=%5Bredacted%5D&page=2');
    expect(redactUrl('https://user:pw@a.test/x')).toBe('https://a.test/x');
  });
  it('detects credentialed requests and summarizes JSON shapes', () => {
    expect(isCredentialed({ cookie: 'session=abc; theme=dark' })).toBe(true);
    expect(isCredentialed({ cookie: 'AWSALBTG=x; AWSALBTGCORS=y; _ga=z' })).toBe(false); // load-balancer and analytics cookies are not credentials
    expect(isCredentialed({ cookie: 'a=b' })).toBe(false);
    expect(isCredentialed({ Authorization: 'Bearer x' })).toBe(true);
    expect(isCredentialed({ 'x-api-key': 'k' })).toBe(true);
    expect(isCredentialed({ accept: 'json' })).toBe(false);
    expect(cookieNames({ cookie: 'session=abc; theme=dark' })).toEqual(['session', 'theme']);
    expect(shapeOfJson('[{"id":1,"name":"a"},{"id":2}]')).toEqual({ kind: 'array', length: 2, itemKeys: ['id', 'name'] });
    expect(shapeOfJson('{"items":[{"sku":"x"}],"total":1}')).toEqual({ kind: 'object', keys: ['items', 'total'], length: 1, itemKeys: ['sku'] });
    expect(shapeOfJson('not json')).toBeUndefined();
  });
});

describe('graphql', () => {
  it('parses requests, classifies operations and redacts variables', () => {
    const info = parseGraphQLRequest('application/json', JSON.stringify({ operationName: 'Search', query: 'query Search($search: String!, $token: String) { search(q: $search) { id } }', variables: { search: 'x', token: 'secret' } }))!;
    expect(info[0]).toMatchObject({ operationName: 'Search', operationType: 'query', variableNames: ['search', 'token'], variables: { search: 'x', token: '[redacted]' } });
    expect(isGraphQLReadOnly(info)).toBe(true);
    expect(isGraphQLReadOnly(parseGraphQLRequest('application/json', JSON.stringify({ query: 'mutation { addFav(id: 1) { ok } }' })))).toBe(false);
    expect(isGraphQLReadOnly(parseGraphQLRequest('application/json', JSON.stringify([{ query: '{ a }' }, { query: 'mutation { b }' }])))).toBe(false);
    expect(parseGraphQLRequest('application/json', '{"not":"graphql"}')).toBeNull();
    expect(parseGraphQLRequest('text/plain', 'query { a }')).toBeNull();
  });
  it('reads variable declarations with scalar and list types', () => {
    const decls = parseGraphQLVariables('query Search($search: String!, $cities: [String], $page: Int = 0, $priceRange: PriceRange, $onlyWithImages: Boolean) { x }');
    expect(decls).toEqual([
      { name: 'search', type: 'String!', required: true, kind: 'string' },
      { name: 'cities', type: '[String]', required: false, kind: 'array', items: 'string' },
      { name: 'page', type: 'Int', required: false, kind: 'integer' },
      { name: 'priceRange', type: 'PriceRange', required: false },
      { name: 'onlyWithImages', type: 'Boolean', required: false, kind: 'boolean' },
    ]);
  });
});
