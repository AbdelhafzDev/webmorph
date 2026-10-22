import { z } from 'zod';
import { defineArtifact } from './common.js';
import { LocatorCandidate } from './elementInventory.js';
import { EvidenceRef } from './websiteModel.js';

export const TOOL_DEFINITION_VERSION = '1.0.0';

export const ToolStatus = z.enum(['draft', 'validated', 'published', 'degraded', 'disabled']);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const ToolErrorCode = z.enum(['INPUT_INVALID', 'PRECONDITION_FAILED', 'OUT_OF_SCOPE', 'LOCATOR_MISSING', 'NOT_FOUND', 'SITE_CHANGED', 'OUTPUT_INVALID', 'BLOCKED', 'TIMEOUT', 'RUNTIME_ERROR', 'TOOL_UNAVAILABLE', 'PERMISSION_DENIED']);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export const LinkListExtractor = z.object({
  kind: z.literal('link-list'),
  into: z.string().default('results'),
  scope: z.enum(['main', 'body']),
  hrefPattern: z.string().describe('Regular expression tested against each link pathname.'),
  excludeHrefPattern: z.string().optional(),
  maxItems: z.number().int().positive(),
});

export const PageFieldSource = z.enum(['title', 'h1', 'url', 'main-text', 'meta-description', 'json-ld-types', 'selector-text']);

export const PageFieldsExtractor = z.object({
  kind: z.literal('page-fields'),
  fields: z.record(
    z.string(),
    z.object({
      source: PageFieldSource,
      selector: z.string().optional(),
      maxChars: z.number().int().positive().optional(),
    }),
  ),
});

export const JsonExtractor = z.object({
  kind: z.literal('json'),
  into: z.string().default('data'),
});

/** Structured data a page publishes for machines: JSON-LD, meta tags, embedded JSON state. Read over HTTP, no browser. */
export const HtmlDataExtractor = z.object({
  kind: z.literal('html-data'),
  jsonLd: z.boolean().default(true),
  meta: z.boolean().default(true),
  embeddedJson: z.boolean().default(true),
});

/** Result list of a server-rendered listing or search page fetched by a preceding http step: links in the main content plus the page's ItemList data. */
export const HtmlListExtractor = z.object({
  kind: z.literal('html-list'),
  into: z.string().default('results'),
  hrefPattern: z.string().describe('Regular expression tested against each result link pathname.'),
  excludeHrefPattern: z.string().optional(),
  maxItems: z.number().int().positive(),
});

/** Repeated result items read in the browser with per-field selectors, as the model observed them (D27). */
export const ItemListExtractor = z.object({
  kind: z.literal('item-list'),
  into: z.string().default('results'),
  item: z.string().describe('CSS selector matching each result item.'),
  fields: z.record(
    z.string(),
    z.object({
      selector: z.string().optional().describe('CSS selector relative to the item; the item itself when omitted.'),
      attr: z.string().optional().describe('Attribute to read instead of the text, e.g. href (resolved to an absolute URL).'),
    }),
  ),
  maxItems: z.number().int().positive(),
});

export const Extractor = z.discriminatedUnion('kind', [LinkListExtractor, PageFieldsExtractor, JsonExtractor, HtmlDataExtractor, HtmlListExtractor, ItemListExtractor]);
export type Extractor = z.infer<typeof Extractor>;

/** One instruction of a declarative tool program. Interpreted by the runtime; never executed as code. */
export const ToolStep = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('navigate'),
    url: z.string().describe('Absolute URL template. {{input}} placeholders are URL-encoded.'),
    query: z.record(z.string(), z.string()).optional().describe('Query parameter name to input name; added only when the input is provided.'),
  }),
  // Locator values may carry {{input}} placeholders (an option named after an input, for example); they are rendered at run time.
  z.object({ op: z.literal('fill'), locator: LocatorCandidate, valueFrom: z.string() }),
  z.object({ op: z.literal('select'), locator: LocatorCandidate, valueFrom: z.string() }),
  z.object({ op: z.literal('click'), locator: LocatorCandidate }),
  z.object({
    op: z.literal('click-result'),
    hrefPattern: z.string().describe('Regular expression over link pathnames that identifies result links.'),
    titleFrom: z.string().optional().describe('Input holding a title to match (case-insensitive substring).'),
    indexFrom: z.string().optional().describe('Input holding a 1-based index.'),
    scope: z.enum(['main', 'body']),
  }),
  z.object({ op: z.literal('press'), locator: LocatorCandidate, key: z.string() }),
  z.object({ op: z.literal('wait'), for: z.enum(['navigation', 'dom-stable', 'selector']), selector: z.string().optional(), timeoutMs: z.number().int().positive() }),
  z.object({ op: z.literal('assert'), check: z.enum(['url-matches', 'selector-present', 'title-not-empty']), value: z.string().optional() }),
  z.object({ op: z.literal('extract'), extractor: Extractor }),
  z.object({
    op: z.literal('http'),
    method: z.enum(['GET', 'POST']),
    url: z.string().describe('Absolute URL template; {{input}} placeholders are URL-encoded.'),
    query: z.record(z.string(), z.string()).optional(),
    fixedQuery: z.record(z.string(), z.string()).optional(),
    accept: z.string().optional(),
    contentType: z.string().optional(),
    credentialRef: z.string().optional().describe('Name of an operator-configured credential (see SiteConfig.apiCredentials) sent as a request header. Resolved from the site config at run time; PERMISSION_DENIED when it is not configured. The value is never part of a tool.'),
    body: z.string().optional().describe('Body template for POST; {{input}} placeholders inside JSON strings are JSON-escaped.'),
    graphql: z
      .object({
        operationName: z.string(),
        query: z.string(),
        variables: z.record(z.string(), z.unknown()),
        optionalVariables: z.record(z.string(), z.string()).optional(),
      })
      .optional()
      .describe('Structured GraphQL body: placeholders in variables are filled, optional variables added when their input is present.'),
  }),
]);
export type ToolStep = z.infer<typeof ToolStep>;

export const ToolSpec = z.object({
  toolId: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  version: z.string(),
  title: z.string(),
  description: z.string(),
  capabilityId: z.string(),
  entity: z.string().optional(),
  sideEffectClass: z.enum(['read', 'write', 'consequential']),
  idempotent: z.boolean(),
  authRequirement: z.enum(['none', 'session']),
  transport: z.enum(['browser', 'http']).optional().describe('http tools run through the safe HTTP client with no browser.'),
  timeoutMs: z.number().int().positive(),
  inputSchema: z.record(z.string(), z.unknown()).describe('JSON Schema (draft 2020-12 subset).'),
  outputSchema: z.record(z.string(), z.unknown()),
  preconditions: z.array(z.object({ kind: z.enum(['scope', 'no-auth', 'credential', 'page-reachable']), detail: z.string() })),
  program: z.array(ToolStep).min(1),
  expectedOutcome: z.string(),
  errorCases: z.array(z.object({ code: ToolErrorCode, when: z.string() })),
  examples: z.array(z.object({ inputs: z.record(z.string(), z.unknown()), note: z.string().optional() })),
  evidence: z.array(EvidenceRef),
  status: ToolStatus,
});
export type ToolSpec = z.infer<typeof ToolSpec>;

/** Why a read capability got no HTTP tool: the gap an agent would otherwise discover by trial. */
export const ApiGap = z.object({
  capabilityId: z.string(),
  name: z.string(),
  reason: z.enum(['client-rendered', 'credentialed', 'write', 'no-sample', 'no-mechanics']),
  detail: z.string(),
});
export type ApiGap = z.infer<typeof ApiGap>;

export const ToolDefinitionData = z.object({
  tools: z.array(ToolSpec),
  apiGaps: z.array(ApiGap).default([]),
  stats: z.object({
    total: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    bySideEffect: z.record(z.string(), z.number().int().nonnegative()),
    http: z.number().int().nonnegative().default(0),
  }),
});
export type ToolDefinitionData = z.infer<typeof ToolDefinitionData>;

export const ToolDefinition = defineArtifact('ToolDefinition', ToolDefinitionData);
export type ToolDefinition = z.infer<typeof ToolDefinition>;
