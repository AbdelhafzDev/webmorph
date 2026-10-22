import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { discover, ToolExecutor, ToolRegistry, createMcpServer, generatePageDataTool, validateAgainstSchema } from '../src/index.js';
import { describeEmbedded, extractPageData, isSensitiveKey, shapeOfValue } from '../src/html/pageData.js';
import { pageDataSampleUrl } from '../src/tools/sample.js';
import { ToolDefinition, ValidationReport } from '../src/schemas/index.js';
import type { Capability, WebsiteModelData } from '../src/schemas/websiteModel.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

type Schema = Record<string, unknown>;
const props = (s: unknown): Record<string, Schema> => (s as Schema)['properties'] as Record<string, Schema>;

/** Every `type` keyword in a schema fragment, so a test can prove the derived shape constrains nothing. */
function typesIn(schema: unknown, acc: string[] = []): string[] {
  if (!schema || typeof schema !== 'object') return acc;
  for (const [k, v] of Object.entries(schema as Schema)) {
    if (k === 'type') acc.push(String(v));
    else if (k === 'properties' || k === 'items') typesIn(v, acc);
    else if (k !== 'description' && v && typeof v === 'object') typesIn(v, acc);
  }
  return acc;
}

const sample = {
  post: { id: 7, slug: 'x-1', price: { amount: 10, currency: 'SAR' }, tags: ['a', 'b'], images: [], sold: false, soldAt: null },
  seller: { name: 'n', phone: '+1', accessToken: 'abc' },
  similar: [{ slug: 'y-2', price: 5 }, { slug: 'z-3', price: 6 }],
  session: { token: 't', expires: 1 },
};

describe('sensitive keys', () => {
  it('names credential-like and personal keys whatever the casing or separator', () => {
    for (const key of ['token', 'accessToken', 'access_token', 'api_key', 'apiKey', 'user_email', 'phoneNumber', 'session', 'sessionId', 'Authorization', 'otp', 'cookies']) expect(isSensitiveKey(key), key).toBe(true);
    for (const key of ['author', 'authorName', 'keywords', 'tokenizer', 'title', 'phonetic', 'telemetry', 'id', 'price', 'details']) expect(isSensitiveKey(key), key).toBe(false);
  });
});

describe('shapeOfValue', () => {
  it('describes key names and kinds two levels down, with containers beyond that counted, never typed, never valued', () => {
    const shape = shapeOfValue(sample);
    expect(Object.keys(props(shape))).toEqual(['post', 'seller', 'similar', 'session']);
    const post = props(shape)['post']!;
    expect(post['additionalProperties']).toBe(true);
    expect(props(post)['id']).toEqual({ description: 'observed: number' });
    expect(props(post)['slug']).toEqual({ description: 'observed: string' });
    expect(props(post)['sold']).toEqual({ description: 'observed: boolean' });
    expect(props(post)['soldAt']).toEqual({ description: 'observed: null' });
    expect(props(post)['tags']).toEqual({ description: 'observed: array of strings' });
    expect(props(post)['images']).toEqual({ description: 'observed: array, empty on the sample page' });
    // price sits at the second level: its kind is given, its own keys are not.
    expect(props(post)['price']).toEqual({ description: 'observed: object with 2 key(s), beyond the described depth' });
    // Arrays of objects describe the first object's keys at the next level.
    const similar = props(shape)['similar']!;
    expect(similar['description']).toBe('observed: array of objects');
    expect(props(similar['items'])).toEqual({ slug: { description: 'observed: string' }, price: { description: 'observed: number' } });
    // Sensitive keys are named with no kind and no children.
    expect(props(shape)['session']).toEqual({ description: 'not described: the key name looks like a credential or personal data' });
    expect(props(props(shape)['seller']!)['phone']!['description']).toContain('not described');
    expect(props(props(shape)['seller']!)['accessToken']!['description']).toContain('not described');
    const text = JSON.stringify(shape);
    for (const value of ['x-1', 'SAR', 'abc', '+1', '"n"', 'y-2', '"t"', '10', '"7"']) expect(text, value).not.toContain(value);
    expect(typesIn(shape)).toEqual([]);
  });

  it('caps the keys per level at 40 and says how many were left out', () => {
    const wide = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, i]));
    const shape = shapeOfValue({ wide, narrow: { a: 1 } });
    expect(Object.keys(props(props(shape)['wide']!))).toHaveLength(40);
    expect(props(shape)['wide']!['description']).toBe('observed: object (first 40 of 45 keys)');
    expect(props(shape)['narrow']!['description']).toBe('observed: object');
    const top = shapeOfValue(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`t${i}`, true])));
    expect(Object.keys(props(top))).toHaveLength(40);
  });

  it('honours an explicit depth', () => {
    const one = shapeOfValue(sample, { depth: 1 });
    expect(props(one)['post']!['description']).toContain('beyond the described depth');
    const three = shapeOfValue(sample, { depth: 3 });
    expect(Object.keys(props(props(props(three)['post']!)['price']!))).toEqual(['amount', 'currency']);
  });
});

describe('describeEmbedded', () => {
  it('builds the embedded fragment of the output schema and a one-line summary of the keys', () => {
    const { schema, summary } = describeEmbedded({ __PAGE_DATA__: sample, __OTHER__: [1, 2] }, 'https://shop.test/cars/x-1');
    expect(schema).toMatchObject({ type: 'object', additionalProperties: true });
    expect(String(schema['description'])).toContain('https://shop.test/cars/x-1');
    expect(String(schema['description'])).toContain('not enforced');
    expect(Object.keys(props(schema))).toEqual(['__PAGE_DATA__', '__OTHER__']);
    expect(Object.keys(props(props(schema)['__PAGE_DATA__']!))).toEqual(['post', 'seller', 'similar', 'session']);
    expect(props(schema)['__OTHER__']).toEqual({ description: 'observed: array of numbers' });
    expect(summary).toBe('Embedded JSON on the sample page: __PAGE_DATA__ (post, seller, similar, session); __OTHER__ (array).');
  });

  it('lists at most twelve keys per object in the summary and names a sensitive object without its keys', () => {
    const wide = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`k${i}`, i]));
    const { summary, schema } = describeEmbedded({ STATE: wide, __SESSION__: { token: 'x' } }, 'https://shop.test/p/1');
    expect(summary).toBe(`Embedded JSON on the sample page: STATE (${Array.from({ length: 12 }, (_, i) => `k${i}`).join(', ')}, +2 more); __SESSION__.`);
    expect(props(schema)['__SESSION__']!['properties']).toBeUndefined();
  });

  it('says so when the sample page carried no embedded JSON', () => {
    const { schema, summary } = describeEmbedded({}, 'https://shop.test/p/1');
    expect(summary).toBeUndefined();
    expect(String(schema['description'])).toContain('carried none');
    expect(schema).toMatchObject({ type: 'object', properties: {}, additionalProperties: true });
  });

  it('never fails a page whose state differs from the sample: the shape is descriptive', () => {
    const { schema } = describeEmbedded({ __PAGE_DATA__: sample }, 'https://shop.test/cars/x-1');
    const other = { __PAGE_DATA__: { post: { id: '8', price: null, tags: 'none', images: {} }, seller: 'hidden', similar: {}, session: null, extra: 1 }, __NEW__: [] };
    expect(validateAgainstSchema(schema, other)).toEqual([]);
    expect(validateAgainstSchema(schema, {})).toEqual([]);
  });
});

const origin = 'https://shop.test';
const model = { site: { origin } } as unknown as WebsiteModelData;
const detailCap: Capability = {
  capabilityId: 'cap-car',
  kind: 'detail',
  name: 'get_car',
  title: 'Get car',
  description: 'Open a car page matching /cars/{slug} and read its title, heading and text.',
  status: 'observed',
  confidence: 0.8,
  pageUrl: `${origin}/cars/x-1`,
  entity: 'car',
  inputs: [{ name: 'slug', type: 'string', required: true, source: 'path-segment', example: 'x-1' }],
  outputs: [],
  preconditions: [],
  expectedOutcome: 'A car page',
  sideEffectClass: 'read',
  authRequirement: 'none',
  mechanics: { navigateUrl: origin, pathTemplate: '/cars/{{slug}}' },
  evidence: [{ artifactType: 'PageTemplates', refId: 'tpl-1' }],
};
const options = { pageLoadTimeoutMs: 1000, settleTimeoutMs: 100 };

describe('pageDataSampleUrl', () => {
  it('renders the example inputs into the page-data tool\'s URL, encoded once', () => {
    expect(pageDataSampleUrl(detailCap)).toBe(`${origin}/cars/x-1`);
    expect(pageDataSampleUrl({ ...detailCap, inputs: [{ ...detailCap.inputs[0]!, example: 'a b/c' }] })).toBe(`${origin}/cars/a%20b%2Fc`);
    expect(pageDataSampleUrl({ ...detailCap, inputs: [{ ...detailCap.inputs[0]!, example: undefined }] })).toBeUndefined();
    expect(pageDataSampleUrl({ ...detailCap, mechanics: { ...detailCap.mechanics, api: { source: 'documented', method: 'GET', urlTemplate: `${origin}/api/cars/{{slug}}`, queryParams: {}, authRequired: false, credentialed: false } } })).toBeUndefined();
    expect(pageDataSampleUrl({ ...detailCap, kind: 'list' })).toBeUndefined();
  });
});

describe('generatePageDataTool', () => {
  it('describes the sampled embedded JSON in the output schema, the description and the evidence', () => {
    const html = `<html><head><title>X 1</title></head><body><script>window.__PAGE_DATA__ = ${JSON.stringify(sample)};</script></body></html>`;
    const tool = generatePageDataTool(detailCap, model, { ...options, pageSamples: { 'cap-car': { url: `${origin}/cars/x-1`, data: extractPageData(html) } } })!;
    expect(tool.name).toBe('get_car');
    expect(tool.description).toContain('Embedded JSON on the sample page: __PAGE_DATA__ (post, seller, similar, session).');
    const embedded = props(tool.outputSchema)['embedded']!;
    expect(embedded).toMatchObject({ type: 'object', additionalProperties: true });
    expect(Object.keys(props(props(embedded)['__PAGE_DATA__']!))).toEqual(['post', 'seller', 'similar', 'session']);
    expect(props(tool.outputSchema)['jsonLd']).toEqual({ type: 'array' }); // the rest of the envelope is unchanged
    expect(tool.outputSchema['required']).toEqual(['url', 'status', 'title', 'jsonLd', 'embedded']);
    expect(tool.evidence.at(-1)).toMatchObject({ artifactType: 'PageInventory', refId: `${origin}/cars/x-1` });
    expect(JSON.stringify(tool.outputSchema)).not.toContain('SAR');
  });

  it('keeps the generic schema when no sample was read', () => {
    const tool = generatePageDataTool(detailCap, model, options)!;
    expect(props(tool.outputSchema)['embedded']).toEqual({ type: 'object' });
    expect(tool.description).not.toContain('Embedded JSON');
    expect(tool.evidence).toEqual(detailCap.evidence);
    const unsampled = generatePageDataTool(detailCap, model, { ...options, pageSamples: {} })!;
    expect(props(unsampled.outputSchema)['embedded']).toEqual({ type: 'object' });
  });
});

describe('page-data tools describe embedded JSON (fixture)', () => {
  let site: FixtureSite;
  let outDir: string;
  beforeAll(async () => {
    site = await startFixtureSite();
    outDir = await mkdtemp(join(tmpdir(), 'webmorph-embedded-'));
  });
  afterAll(async () => {
    await site.close();
    await rm(outDir, { recursive: true, force: true });
  });

  it('generates get_car with the keys of window.__PAGE_DATA__ in its schema and description, validates it, and serves it over MCP', async () => {
    const result = await discover({
      startUrl: `${site.baseUrl}/cars`,
      outDir,
      allowPrivate: true,
      model: { enabled: false },
      budget: { maxPages: 10, maxDepth: 1, minDelayMs: 0, maxPagesToInspect: 1, maxProbesPerPage: 1, maxProbesTotal: 1, settleTimeoutMs: 800, pageLoadTimeoutMs: 15_000, validationRuns: 1 },
      sleep: async () => {},
    });
    const { store, siteId, jobId } = result;
    const tools = (await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data.tools;
    const tool = tools.find((t) => t.name === 'get_car')!;
    expect(tool, tools.map((t) => t.name).join(', ')).toBeDefined();
    expect(tool.description).toContain('Embedded JSON on the sample page: __PAGE_DATA__ (post, seller, session, similar, flags).');

    // Whichever car page the crawl fetched first is the representative: the sample, the example input and the validated page are all that one.
    const slugs = ['toyota-camry-2020-1', 'honda-accord-2019-2'];
    const representative = String(tool.examples[0]!.inputs['slug']);
    expect(slugs).toContain(representative);
    const otherSlug = slugs.find((s) => s !== representative)!;

    const embedded = props(tool.outputSchema)['embedded']!;
    expect(embedded).toMatchObject({ type: 'object', additionalProperties: true });
    expect(String(embedded['description'])).toContain(`${site.baseUrl}/cars/${representative}`);
    expect(tool.evidence.at(-1)).toMatchObject({ artifactType: 'PageInventory', refId: `${site.baseUrl}/cars/${representative}` });
    const pageData = props(embedded)['__PAGE_DATA__']!;
    expect(pageData['additionalProperties']).toBe(true);
    expect(Object.keys(props(pageData))).toEqual(['post', 'seller', 'session', 'similar', 'flags']); // the page's own key order
    const post = props(pageData)['post']!;
    expect(Object.keys(props(post))).toEqual(['id', 'slug', 'title', 'price', 'specs', 'gallery', 'featured', 'soldAt']);
    expect(props(post)['id']).toEqual({ description: 'observed: number' });
    expect(props(post)['price']!['properties']).toBeUndefined(); // third level: counted, not described
    expect(props(post)['price']!['description']).toContain('object with 2 key(s)');
    expect(props(post)['soldAt']).toEqual({ description: 'observed: null' });
    expect(props(props(pageData)['similar']!['items'])).toEqual({ slug: { description: 'observed: string' }, title: { description: 'observed: string' }, price: { description: 'observed: number' } });
    expect(props(pageData)['session']).toEqual({ description: 'not described: the key name looks like a credential or personal data' });
    expect(props(props(pageData)['seller']!)['phone']!['description']).toContain('not described');
    expect(props(props(pageData)['flags']!)['verified']).toEqual({ description: 'observed: boolean' });
    // Keys and kinds only: no value from the page reaches the definition.
    const definition = `${tool.description} ${JSON.stringify(tool.outputSchema)}`;
    for (const value of ['visitor-secret', '+9665', 'Fixture Motors', 'Camry', 'Accord', '59500', '48000', 'SAR', 'petrol']) expect(definition, value).not.toContain(value);
    expect(typesIn(pageData)).toEqual([]);

    const report = (await store.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport)).data;
    const v = report.tools.find((t) => t.name === 'get_car')!;
    expect(v.verdict, v.failureReasons.join('; ')).toBe('validated');
    const output = v.runs[0]!.output as { embedded: { __PAGE_DATA__: { post: { price: { amount: number } }; similar: Array<{ slug: string }> } } };
    expect(output.embedded.__PAGE_DATA__.post.price.amount).toBe(representative === 'toyota-camry-2020-1' ? 59500 : 48000);
    expect(output.embedded.__PAGE_DATA__.similar.map((s) => s.slug)).toEqual([otherSlug]);

    // The MCP client validates structured results against the output schema with Ajv: a different page must pass.
    const registry = new ToolRegistry(store, siteId);
    await registry.publish({ names: ['get_car'] });
    const executor = new ToolExecutor({ store, siteId });
    const server = createMcpServer({ executor, siteId, origin: site.baseUrl });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools.find((t) => t.name === 'get_car')!;
      expect(listed.description).toContain('__PAGE_DATA__ (post, seller, session, similar, flags)');
      expect(Object.keys(props(props(listed.outputSchema)['embedded']!))).toEqual(['__PAGE_DATA__']);
      const call = await client.callTool({ name: 'get_car', arguments: { slug: 'honda-accord-2019-2' } });
      expect(call.isError, JSON.stringify(call.content)).toBeFalsy();
      const structured = call.structuredContent as { embedded: { __PAGE_DATA__: { post: { slug: string; price: { currency: string } }; similar: Array<{ slug: string }> } } };
      expect(structured.embedded.__PAGE_DATA__.post.slug).toBe('honda-accord-2019-2');
      expect(structured.embedded.__PAGE_DATA__.similar[0]?.slug).toBe('toyota-camry-2020-1');
    } finally {
      await client.close();
      await executor.close();
    }
  }, 180_000);
});
