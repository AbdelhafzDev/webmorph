import type { Capability, WebsiteModelData } from '../schemas/websiteModel.js';
import type { ApiGap, ToolSpec, ToolStep } from '../schemas/toolDefinition.js';
import type { ElementInventory } from '../schemas/elementInventory.js';
import { preferredLocator } from '../browser/locators.js';
import { shortHash } from '../core/ids.js';
import { escapeRegex } from '../model/naming.js';
import { describeEmbedded } from '../html/pageData.js';
import type { PageSample } from './sample.js';
import type { WorkflowDefinitionRecord } from '../schemas/workflowDefinition.js';
import { generateProgramTool } from './generateProgram.js';

export interface GenerateOptions {
  pageLoadTimeoutMs: number;
  settleTimeoutMs: number;
  elements?: ElementInventory;
  maxItems?: number;
  /** Detail pages read once during generation, by capability id: the page-data tool describes the embedded JSON found there. */
  pageSamples?: Record<string, PageSample>;
}

const LINK_LIST_OUTPUT = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'], additionalProperties: false },
    },
    count: { type: 'integer', minimum: 0 },
    pageUrl: { type: 'string' },
  },
  required: ['results', 'count', 'pageUrl'],
  additionalProperties: false,
};

const PAGE_OUTPUT = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    heading: { type: 'string' },
    description: { type: 'string' },
    text: { type: 'string' },
    url: { type: 'string' },
    types: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'url'],
  additionalProperties: false,
};

const STANDARD_ERRORS: ToolSpec['errorCases'] = [
  { code: 'INPUT_INVALID', when: 'inputs do not match the input schema' },
  { code: 'OUT_OF_SCOPE', when: 'the navigation target is outside the allowed hosts' },
  { code: 'BLOCKED', when: 'the site answered with a bot challenge or rate limit' },
  { code: 'NOT_FOUND', when: 'the page answered 404 or 410' },
  { code: 'TIMEOUT', when: 'the page did not load within the timeout' },
  { code: 'SITE_CHANGED', when: 'an assertion about the page failed; the site may have changed' },
  { code: 'OUTPUT_INVALID', when: 'extracted data did not match the output schema' },
];

function inputSchemaFor(cap: Capability): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const i of cap.inputs) {
    const prop: Record<string, unknown> = i.type === 'array' ? { type: 'array', items: { type: i.items ?? 'string' } } : { type: i.type };
    if (i.description) prop['description'] = i.description;
    if (i.enum?.length) prop['enum'] = i.enum;
    if (i.minimum !== undefined) prop['minimum'] = i.minimum;
    if (i.type === 'string' && i.required) prop['minLength'] = 1;
    properties[i.name] = prop;
    if (i.required) required.push(i.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function exampleInputs(cap: Capability): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const i of cap.inputs) {
    if (i.example !== undefined) out[i.name] = i.type === 'integer' ? Number(i.example) : i.example;
    else if (i.required) out[i.name] = i.type === 'integer' ? 1 : i.enum?.[0] ?? 'test';
  }
  return out;
}

/** Turn a capability into a declarative tool. Returns null when the mechanics are insufficient. */
export function generateTool(cap: Capability, model: WebsiteModelData, options: GenerateOptions): ToolSpec | null {
  const m = cap.mechanics;
  const timeoutMs = options.pageLoadTimeoutMs + options.settleTimeoutMs * 2 + 5_000;
  const program: ToolStep[] = [];
  let outputSchema: Record<string, unknown>;
  const maxItems = options.maxItems ?? 100;

  if (cap.kind === 'search') {
    if (!m.navigateUrl || !m.queryParams) return null;
    if (m.pathTemplate) {
      program.push({ op: 'navigate', url: `${m.navigateUrl}${m.pathTemplate}` });
    } else if (m.directUrlObserved || !m.formId) {
      program.push({ op: 'navigate', url: m.navigateUrl, query: m.queryParams });
    } else {
      const field = options.elements?.data.elements.find((e) => e.elementId === m.fieldElementIds?.[0]);
      const locator = field ? preferredLocator(field.locators) : undefined;
      if (!locator) return null;
      program.push({ op: 'navigate', url: cap.pageUrl });
      program.push({ op: 'fill', locator, valueFrom: 'query' });
      program.push({ op: 'press', locator, key: 'Enter' });
      program.push({ op: 'wait', for: 'navigation', timeoutMs: options.settleTimeoutMs * 2 });
    }
    program.push({ op: 'wait', for: 'dom-stable', timeoutMs: options.settleTimeoutMs });
    program.push({ op: 'assert', check: 'url-matches', value: `^${escapeRegex(m.pathTemplate ? m.navigateUrl + m.pathTemplate.split('{{')[0]! : m.navigateUrl)}` });
    program.push({ op: 'extract', extractor: { kind: 'link-list', into: 'results', scope: 'main', hrefPattern: m.resultLinkPattern ?? '^/.+', maxItems } });
    outputSchema = LINK_LIST_OUTPUT;
  } else if (cap.kind === 'list') {
    if (!m.navigateUrl) return null;
    const query = m.queryParams && Object.keys(m.queryParams).length ? { query: m.queryParams } : {};
    if (m.pathTemplate) {
      // A listing per category (/autos/{{make}}): the path input picks the page, result links are extracted as usual.
      const prefix = m.navigateUrl + m.pathTemplate.split('{{')[0]!;
      program.push({ op: 'navigate', url: `${m.navigateUrl}${m.pathTemplate}`, ...query });
      program.push({ op: 'wait', for: 'dom-stable', timeoutMs: options.settleTimeoutMs });
      program.push({ op: 'assert', check: 'url-matches', value: `^${escapeRegex(prefix)}` });
      program.push({ op: 'extract', extractor: { kind: 'link-list', into: 'results', scope: 'main', hrefPattern: m.resultLinkPattern ?? '^/.+', excludeHrefPattern: `^${escapeRegex(new URL(prefix).pathname)}[^/?#]*/?$`, maxItems } });
    } else {
      program.push({ op: 'navigate', url: m.navigateUrl, ...query });
      program.push({ op: 'wait', for: 'dom-stable', timeoutMs: options.settleTimeoutMs });
      program.push({ op: 'assert', check: 'url-matches', value: `^${escapeRegex(m.navigateUrl)}` });
      program.push({ op: 'extract', extractor: { kind: 'link-list', into: 'results', scope: 'main', hrefPattern: m.resultLinkPattern ?? '^/.+', excludeHrefPattern: `^${escapeRegex(new URL(m.navigateUrl).pathname)}/?$`, maxItems } });
    }
    outputSchema = LINK_LIST_OUTPUT;
  } else if (cap.kind === 'detail') {
    if (!m.navigateUrl || !m.pathTemplate) return null;
    program.push({ op: 'navigate', url: `${m.navigateUrl}${m.pathTemplate}` });
    program.push({ op: 'wait', for: 'dom-stable', timeoutMs: options.settleTimeoutMs });
    program.push({ op: 'assert', check: 'title-not-empty' });
    program.push({
      op: 'extract',
      extractor: {
        kind: 'page-fields',
        fields: {
          title: { source: 'title' },
          heading: { source: 'h1' },
          description: { source: 'meta-description' },
          text: { source: 'main-text', maxChars: 2000 },
          url: { source: 'url' },
          types: { source: 'json-ld-types' },
        },
      },
    });
    outputSchema = PAGE_OUTPUT;
  } else {
    return null;
  }

  const entityLabel = cap.entity?.replace(/_/g, ' ');
  return {
    toolId: `tool-${shortHash(`${model.site.origin}|${cap.capabilityId}`, 12)}`,
    name: cap.name,
    version: '1.0.0',
    title: cap.title,
    description: cap.description,
    capabilityId: cap.capabilityId,
    ...(cap.entity ? { entity: cap.entity } : {}),
    sideEffectClass: cap.sideEffectClass,
    idempotent: cap.sideEffectClass === 'read',
    authRequirement: cap.authRequirement,
    timeoutMs,
    inputSchema: inputSchemaFor(cap),
    outputSchema,
    preconditions: [
      { kind: 'scope', detail: `target stays within ${model.site.origin}` },
      ...(cap.authRequirement === 'none' ? [{ kind: 'no-auth' as const, detail: 'no session required' }] : []),
      { kind: 'page-reachable', detail: `${m.navigateUrl ?? cap.pageUrl} responds without a bot challenge` },
    ],
    program,
    expectedOutcome: cap.expectedOutcome,
    errorCases: STANDARD_ERRORS,
    examples: [{ inputs: exampleInputs(cap), note: entityLabel ? `example for ${entityLabel}` : 'derived from evidence' }],
    evidence: cap.evidence,
    status: 'draft',
  };
}

const JSON_OUTPUT = {
  type: 'object',
  properties: { data: { type: ['object', 'array'] }, status: { type: 'integer' }, url: { type: 'string' } },
  required: ['data', 'status', 'url'],
  additionalProperties: false,
};

/**
 * HTTP variant of a capability: the site's own JSON API, documented or observed, public and read-only. An API whose
 * observed requests carried only a session-like cookie (no authorization header) is generated too: the tool sends no
 * cookies, so the replay during validation decides whether the endpoint is public, and a 401 or 403 fails it (D21).
 */
export function generateApiTool(cap: Capability, model: WebsiteModelData, options: GenerateOptions): ToolSpec | null {
  const api = cap.mechanics.api;
  if (!api || api.authRequired) return null;
  const cookieOnly = api.credentialed && api.credentialSource === 'cookie';
  if (api.credentialed && !cookieOnly) return null;
  if (api.method === 'POST' && !api.graphql) return null; // only GraphQL queries are known reads over POST
  if (!model.site.origin || !api.urlTemplate.startsWith('http')) return null;
  const placeholders = api.graphql ? Array.from(JSON.stringify(api.graphql.variables).matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)).map((m) => m[1]!) : [];
  const inputs = [...cap.inputs.filter((i) => i.source === 'path-segment' || Object.values(api.queryParams).includes(i.name) || placeholders.includes(i.name)), ...(api.graphql?.optionalInputs ?? [])];
  const capForSchema: Capability = { ...cap, inputs };
  const timeoutMs = options.pageLoadTimeoutMs + 5_000;
  const where = api.source === 'both' ? `documented at ${api.specUrl} and observed during discovery` : api.source === 'documented' ? `documented at ${api.specUrl}` : api.graphql ? `GraphQL operation ${api.graphql.operationName} observed during discovery` : 'observed during discovery';
  // An operator-configured credential (D23) is carried by name only; the interpreter resolves it from the site config at run time.
  const credentialRef = api.credentialRef;
  return {
    toolId: `tool-${shortHash(`${model.site.origin}|${cap.capabilityId}|api`, 12)}`,
    name: cap.name,
    version: '1.0.0',
    title: `${cap.title} (API)`,
    description: `${cap.description} Uses the site's JSON API (${where}) instead of the browser${credentialRef ? `, sending the operator-configured credential "${credentialRef}"` : ''}; prefer it when available.`,
    capabilityId: cap.capabilityId,
    ...(cap.entity ? { entity: cap.entity } : {}),
    sideEffectClass: 'read',
    idempotent: true,
    authRequirement: 'none',
    transport: 'http',
    timeoutMs,
    inputSchema: inputSchemaFor(capForSchema),
    outputSchema: JSON_OUTPUT,
    preconditions: [
      { kind: 'scope', detail: `target stays within ${model.site.origin}` },
      credentialRef
        ? { kind: 'credential', detail: `operator-configured credential "${credentialRef}" is present in the site config; the endpoint answered with it during discovery` }
        : cookieOnly
          ? { kind: 'no-auth', detail: 'the site\'s front end sent a session-like cookie and no authorization header with this request; the tool sends no cookies, and the cookie-less replay during validation decides whether the endpoint is public' }
          : { kind: 'no-auth', detail: 'endpoint answered without credentials during discovery' },
      { kind: 'page-reachable', detail: `${api.urlTemplate} answers JSON` },
    ],
    program: [
      api.graphql
        ? { op: 'http', method: 'POST', url: api.urlTemplate, ...(api.fixedQuery ? { fixedQuery: api.fixedQuery } : {}), contentType: 'application/json', accept: 'application/json', ...(credentialRef ? { credentialRef } : {}), graphql: { operationName: api.graphql.operationName, query: api.graphql.query, variables: api.graphql.variables, ...(api.graphql.optionalVariables ? { optionalVariables: api.graphql.optionalVariables } : {}) } }
        : { op: 'http', method: 'GET', url: api.urlTemplate, ...(Object.keys(api.queryParams).length ? { query: api.queryParams } : {}), accept: 'application/json', ...(credentialRef ? { credentialRef } : {}) },
      { op: 'extract', extractor: { kind: 'json', into: 'data' } },
    ],
    expectedOutcome: `A JSON ${api.responseShape?.kind ?? 'document'} describing ${cap.entity?.replace(/_/g, ' ') ?? 'the result'}${api.graphql ? ` (GraphQL ${api.graphql.operationName})` : ''}`,
    errorCases: credentialRef
      ? [...STANDARD_ERRORS, { code: 'PERMISSION_DENIED', when: `the configured credential "${credentialRef}" is missing from the site config, or the endpoint refused it` }]
      : cookieOnly
        ? [...STANDARD_ERRORS, { code: 'PERMISSION_DENIED', when: 'the endpoint answered 401 or 403 without the cookie the site\'s front end sent; it is not public after all' }]
        : STANDARD_ERRORS,
    examples: [{ inputs: exampleInputs(capForSchema), note: 'derived from evidence' }],
    evidence: cap.evidence.filter((e) => e.artifactType === 'DocumentationIndex' || e.artifactType === 'ApiCandidates'),
    status: 'draft',
  };
}

/** A recorded workflow as a tool: the user's steps, replayed by the interpreter. Write workflows stay unpublishable. */
export function generateWorkflowTool(wf: WorkflowDefinitionRecord, model: WebsiteModelData, options: GenerateOptions): ToolSpec {
  const cap: Capability = {
    capabilityId: `workflow:${wf.workflowId}`,
    kind: 'other',
    name: wf.name,
    title: wf.title,
    description: wf.intent,
    status: 'observed',
    confidence: 0.7,
    pageUrl: wf.source.startUrl,
    inputs: wf.inputs,
    outputs: [],
    preconditions: wf.preconditions,
    expectedOutcome: wf.expectedOutcome,
    sideEffectClass: wf.sideEffectClass,
    authRequirement: wf.authRequirement,
    mechanics: {},
    evidence: wf.evidence,
  };
  const lastExtract = [...wf.steps].reverse().find((s) => s.op === 'extract');
  const outputSchema = lastExtract && lastExtract.op === 'extract' && lastExtract.extractor.kind === 'link-list' ? LINK_LIST_OUTPUT : PAGE_OUTPUT;
  return {
    toolId: `tool-${shortHash(`${model.site.origin}|workflow|${wf.workflowId}`, 12)}`,
    name: wf.name,
    version: '1.0.0',
    title: wf.title,
    description: `${wf.intent}. Reconstructed from a recorded session (${wf.source.eventCount} events)${wf.requiresApproval ? '; performs a write and requires approval before use' : ''}.`,
    capabilityId: cap.capabilityId,
    sideEffectClass: wf.sideEffectClass,
    idempotent: wf.sideEffectClass === 'read',
    authRequirement: wf.authRequirement,
    transport: 'browser',
    timeoutMs: options.pageLoadTimeoutMs + options.settleTimeoutMs * Math.max(2, wf.steps.length) + 5_000,
    inputSchema: inputSchemaFor(cap),
    outputSchema,
    preconditions: [
      { kind: 'scope', detail: `target stays within ${model.site.origin}` },
      ...(wf.authRequirement === 'none' ? [{ kind: 'no-auth' as const, detail: 'no session required' }] : [{ kind: 'no-auth' as const, detail: 'requires a signed-in session that this runtime does not provide' }]),
      { kind: 'page-reachable', detail: `${wf.source.startUrl} responds without a bot challenge` },
    ],
    program: wf.steps,
    expectedOutcome: wf.expectedOutcome,
    errorCases: STANDARD_ERRORS,
    examples: [{ inputs: exampleInputs(cap), note: wf.replayable ? 'values from the recording' : 'some recorded values were not kept; replay may need real inputs' }],
    evidence: wf.evidence,
    status: 'draft',
  };
}

const PAGE_DATA_OUTPUT = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    status: { type: 'integer' },
    title: { type: 'string' },
    description: { type: 'string' },
    canonical: { type: 'string' },
    og: { type: 'object' },
    jsonLd: { type: 'array' },
    jsonLdTypes: { type: 'array', items: { type: 'string' } },
    breadcrumbs: { type: 'array', items: { type: 'string' } },
    embedded: { type: 'object' },
  },
  required: ['url', 'status', 'title', 'jsonLd', 'embedded'],
  additionalProperties: false,
};

/**
 * Detail over HTTP: the structured data a page publishes (JSON-LD, meta tags, embedded JSON). Validated only when the page has some.
 * When the sample page was read, the embedded JSON it carried is described in the output schema and the description: key names and
 * observed kinds, as annotations that never constrain, since one page is evidence of what the site publishes, not a contract.
 */
export function generatePageDataTool(cap: Capability, model: WebsiteModelData, options: GenerateOptions): ToolSpec | null {
  const m = cap.mechanics;
  if (cap.kind !== 'detail' || !m.navigateUrl || !m.pathTemplate || cap.mechanics.api) return null;
  const inputs = cap.inputs.filter((i) => i.source === 'path-segment');
  const capForSchema: Capability = { ...cap, inputs };
  const sample = options.pageSamples?.[cap.capabilityId];
  const embedded = sample ? describeEmbedded(sample.data.embedded, sample.url) : undefined;
  const outputSchema = embedded ? { ...PAGE_DATA_OUTPUT, properties: { ...PAGE_DATA_OUTPUT.properties, embedded: embedded.schema } } : PAGE_DATA_OUTPUT;
  return {
    toolId: `tool-${shortHash(`${model.site.origin}|${cap.capabilityId}|page-data`, 12)}`,
    name: cap.name,
    version: '1.0.0',
    title: `${cap.title} (structured data)`,
    description: `${cap.description} Reads the page over HTTP and returns the structured data it publishes (JSON-LD, Open Graph and meta tags, embedded JSON state); no browser.${embedded?.summary ? ` ${embedded.summary}` : ''}`,
    capabilityId: cap.capabilityId,
    ...(cap.entity ? { entity: cap.entity } : {}),
    sideEffectClass: 'read',
    idempotent: true,
    authRequirement: 'none',
    transport: 'http',
    timeoutMs: options.pageLoadTimeoutMs + 5_000,
    inputSchema: inputSchemaFor(capForSchema),
    outputSchema,
    preconditions: [
      { kind: 'scope', detail: `target stays within ${model.site.origin}` },
      { kind: 'no-auth', detail: 'no session required' },
      { kind: 'page-reachable', detail: `${m.navigateUrl}${m.pathTemplate} answers HTML with structured data` },
    ],
    program: [
      { op: 'http', method: 'GET', url: `${m.navigateUrl}${m.pathTemplate}`, accept: 'text/html,application/xhtml+xml' },
      { op: 'extract', extractor: { kind: 'html-data', jsonLd: true, meta: true, embeddedJson: true } },
    ],
    expectedOutcome: `Structured data describing one ${cap.entity?.replace(/_/g, ' ') ?? 'page'}`,
    errorCases: STANDARD_ERRORS,
    examples: [{ inputs: exampleInputs(capForSchema), note: 'derived from evidence' }],
    evidence: sample ? [...cap.evidence, { artifactType: 'PageInventory', refId: sample.url, note: 'sample page read during generation; the embedded JSON shape in the output schema was observed there' }] : cap.evidence,
    status: 'draft',
  };
}

const LIST_DATA_OUTPUT = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          image: { type: 'string' },
          description: { type: 'string' },
          price: { type: 'number' },
          currency: { type: 'string' },
          availability: { type: 'string', description: 'schema.org availability, e.g. InStock' },
          condition: { type: 'string', description: 'schema.org item condition, e.g. UsedCondition' },
        },
        required: ['title', 'url'],
        additionalProperties: false,
      },
    },
    count: { type: 'integer', minimum: 0 },
    pageUrl: { type: 'string' },
    status: { type: 'integer' },
  },
  required: ['results', 'count', 'pageUrl'],
  additionalProperties: false,
};

/** Fewer result links than this in the sampled HTML means the page renders its results client-side. */
export const MIN_SERVER_RENDERED_RESULTS = 3;

/**
 * Listing or search over HTTP: when the landing page already contains its results (server-rendered), one GET and a
 * parse replace the browser. The sample read during generation is the evidence; the tool is validated by replay like
 * any other, and the page's ItemList data (price, availability, images) rides along when the page publishes it.
 */
export function generateListHttpTool(cap: Capability, model: WebsiteModelData, options: GenerateOptions): ToolSpec | null {
  const m = cap.mechanics;
  if ((cap.kind !== 'list' && cap.kind !== 'search') || !m.navigateUrl || !m.resultLinkPattern) return null;
  if (cap.kind === 'search' && !m.pathTemplate && !m.directUrlObserved) return null; // a form that must be filled has no URL to GET
  const sample = options.pageSamples?.[cap.capabilityId];
  if (!sample?.list || sample.list.count < MIN_SERVER_RENDERED_RESULTS) return null;
  const maxItems = options.maxItems ?? 100;
  const url = `${m.navigateUrl}${m.pathTemplate ?? ''}`;
  const query = m.queryParams && Object.keys(m.queryParams).length ? { query: m.queryParams } : {};
  const selfPath = m.pathTemplate ? undefined : new URL(m.navigateUrl).pathname;
  const enriched = sample.list.itemListCount > 0;
  return {
    toolId: `tool-${shortHash(`${model.site.origin}|${cap.capabilityId}|list-http`, 12)}`,
    name: cap.name,
    version: '1.0.0',
    title: `${cap.title} (HTTP)`,
    description: `${cap.description} Reads the page over HTTP and returns the result links it already contains${enriched ? ', with price, availability and images from the page’s ItemList data' : ''}; no browser. ${sample.list.count} results were observed in the sample page.`,
    capabilityId: cap.capabilityId,
    ...(cap.entity ? { entity: cap.entity } : {}),
    sideEffectClass: 'read',
    idempotent: true,
    authRequirement: 'none',
    transport: 'http',
    timeoutMs: options.pageLoadTimeoutMs + 5_000,
    inputSchema: inputSchemaFor(cap),
    outputSchema: LIST_DATA_OUTPUT,
    preconditions: [
      { kind: 'scope', detail: `target stays within ${model.site.origin}` },
      { kind: 'no-auth', detail: 'no session required' },
      { kind: 'page-reachable', detail: `${url} answers HTML that already contains the results (${sample.list.count} observed during generation)` },
    ],
    program: [
      { op: 'http', method: 'GET', url, ...query, accept: 'text/html,application/xhtml+xml' },
      { op: 'extract', extractor: { kind: 'html-list', into: 'results', hrefPattern: m.resultLinkPattern, ...(selfPath ? { excludeHrefPattern: `^${escapeRegex(selfPath)}/?$` } : {}), maxItems } },
    ],
    expectedOutcome: `A list of ${cap.entity?.replace(/_/g, ' ') ?? 'result'} links${enriched ? ' with offer data' : ''} read from the page HTML`,
    errorCases: STANDARD_ERRORS,
    examples: [{ inputs: exampleInputs(cap), note: 'derived from evidence' }],
    evidence: [...cap.evidence, { artifactType: 'PageInventory', refId: sample.url, note: `sample page read during generation carried ${sample.list.count} result link(s)${enriched ? ` and an ItemList of ${sample.list.itemListCount}` : ''}` }],
    status: 'draft',
  };
}

/** Why a read capability has no HTTP route; reported so the gap is a fact of the output rather than a surprise at call time. */
function apiGapFor(cap: Capability, options: GenerateOptions): ApiGap {
  const base = { capabilityId: cap.capabilityId, name: cap.name };
  const api = cap.mechanics.api;
  if (api?.credentialed && api.credentialSource !== 'cookie' && !api.credentialRef) return { ...base, reason: 'credentialed', detail: `the observed ${api.method} ${api.urlTemplate} carried a credential header; a configured credential (webmorph credentials set) would enable it` };
  if (api?.authRequired) return { ...base, reason: 'credentialed', detail: `${api.urlTemplate} is documented as requiring authentication` };
  if (api && api.method === 'POST' && !api.graphql) return { ...base, reason: 'write', detail: `${api.urlTemplate} is a POST that is not a GraphQL query` };
  if (cap.kind === 'list' || cap.kind === 'search') {
    if (cap.kind === 'search' && !cap.mechanics.pathTemplate && !cap.mechanics.directUrlObserved) return { ...base, reason: 'no-mechanics', detail: 'the search form has no URL form; results are reached only by submitting it' };
    const sample = options.pageSamples?.[cap.capabilityId];
    if (!sample) return { ...base, reason: 'no-sample', detail: 'the landing page could not be read without a browser during generation' };
    if (!sample.list || sample.list.count < MIN_SERVER_RENDERED_RESULTS) return { ...base, reason: 'client-rendered', detail: `the landing page HTML carried ${sample.list?.count ?? 0} result link(s); the results are rendered client-side` };
  }
  if (cap.kind === 'detail' && (!cap.mechanics.navigateUrl || !cap.mechanics.pathTemplate)) return { ...base, reason: 'no-mechanics', detail: 'no URL template for the page' };
  return { ...base, reason: 'no-mechanics', detail: 'no documented or observed route without a browser' };
}

export interface GeneratedToolSet {
  tools: ToolSpec[];
  /** Read capabilities that got no HTTP tool, with the reason. */
  apiGaps: ApiGap[];
}

/**
 * Tools for every read capability, API first: the HTTP route (the site's JSON API, the page's structured data, or the
 * server-rendered result list) carries the capability's own name, and the browser route is the fallback, suffixed
 * `_browser` when an HTTP route exists and plain otherwise. A capability with no HTTP route is reported as a gap.
 */
export function generateToolSet(model: WebsiteModelData, options: GenerateOptions, workflows: WorkflowDefinitionRecord[] = []): GeneratedToolSet {
  const tools: ToolSpec[] = [];
  const apiGaps: ApiGap[] = [];
  const names = new Set<string>();
  for (const wf of workflows) {
    const tool = generateWorkflowTool(wf, model, options);
    if (names.has(tool.name)) continue;
    names.add(tool.name);
    tools.push(tool);
  }
  for (const cap of model.capabilities) {
    if (cap.sideEffectClass !== 'read') continue; // v1 publishes read-only tools only
    const http = generateApiTool(cap, model, options) ?? generatePageDataTool(cap, model, options) ?? generateListHttpTool(cap, model, options);
    const browser = cap.mechanics.program ? generateProgramTool(cap, model, options) : generateTool(cap, model, options);
    if (browser && http) {
      browser.name = `${cap.name}_browser`;
      browser.title = `${browser.title} (browser)`;
      browser.description = `${browser.description} Drives the page in a browser; prefer ${cap.name}, which needs none.`;
    }
    if (!http) apiGaps.push(apiGapFor(cap, options));
    for (const tool of [http, browser]) {
      if (!tool || names.has(tool.name)) continue;
      names.add(tool.name);
      tools.push(tool);
    }
  }
  return { tools, apiGaps };
}

export function generateTools(model: WebsiteModelData, options: GenerateOptions, workflows: WorkflowDefinitionRecord[] = []): ToolSpec[] {
  return generateToolSet(model, options, workflows).tools;
}
