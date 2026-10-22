import { z } from 'zod';
import { ArtifactType, defineArtifact } from './common.js';
import { TemplateKind } from './pageTemplates.js';
import { RenderModeKind } from './pageInventory.js';

export const WEBSITE_MODEL_VERSION = '1.0.0';

export const EvidenceRef = z.object({
  artifactType: ArtifactType,
  refId: z.string().optional().describe('elementId, formId, probeId, templateId or page URL inside that artifact.'),
  note: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const Fact = z.object({
  factId: z.string(),
  statement: z.string(),
  evidence: z.array(EvidenceRef).min(1),
});
export type Fact = z.infer<typeof Fact>;

export const Hypothesis = z.object({
  hypothesisId: z.string(),
  statement: z.string(),
  confidence: z.number().min(0).max(1),
  basedOn: z.array(z.string()).describe('Fact IDs this hypothesis rests on.'),
  source: z.enum(['heuristic', 'model']),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const PageType = z.object({
  pageTypeId: z.string(),
  urlPattern: z.string(),
  kind: TemplateKind,
  label: z.string(),
  description: z.string().optional(),
  pageCount: z.number().int().nonnegative(),
  representativeUrls: z.array(z.string()),
  inspected: z.boolean().describe('At least one member was rendered in the browser.'),
});
export type PageType = z.infer<typeof PageType>;

export const Entity = z.object({
  entityId: z.string(),
  name: z.string().describe('Singular, snake_case.'),
  plural: z.string(),
  description: z.string().optional(),
  detailPageTypeId: z.string().optional(),
  listPageTypeIds: z.array(z.string()),
  identifierSegment: z.string().optional().describe('{id} or {slug}'),
  confidence: z.number().min(0).max(1),
  source: z.enum(['heuristic', 'model']),
});
export type Entity = z.infer<typeof Entity>;

export const CapabilityKind = z.enum(['search', 'list', 'detail', 'navigate', 'auth', 'form', 'other']);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

export const CapabilityInput = z.object({
  name: z.string(),
  type: z.enum(['string', 'integer', 'number', 'boolean', 'array']),
  items: z.enum(['string', 'integer', 'number']).optional().describe('Element type for array inputs.'),
  required: z.boolean(),
  description: z.string().optional(),
  source: z.enum(['form-field', 'url-param', 'path-segment']),
  param: z.string().optional().describe('Query parameter or form field name.'),
  enum: z.array(z.string()).optional(),
  minimum: z.number().optional(),
  example: z.string().optional(),
});
export type CapabilityInput = z.infer<typeof CapabilityInput>;

export const CapabilityOutput = z.object({
  name: z.string(),
  type: z.enum(['string', 'integer', 'array', 'object']),
  description: z.string().optional(),
});

export const CapabilityMechanics = z.object({
  formId: z.string().optional(),
  fieldElementIds: z.array(z.string()).optional(),
  submitElementId: z.string().optional(),
  action: z.string().optional(),
  method: z.enum(['get', 'post']).optional(),
  navigateUrl: z.string().optional().describe('Absolute URL to open, without query parameters.'),
  pathTemplate: z.string().optional().describe('Path with {{input}} placeholders, e.g. /products/{{id}}'),
  queryParams: z.record(z.string(), z.string()).optional().describe('Query parameter name to input name.'),
  resultLinkPattern: z.string().optional().describe('Regular expression over result link pathnames.'),
  resultsPageTypeId: z.string().optional(),
  directUrlObserved: z.boolean().optional().describe('A probe showed the GET form resolves to a plain URL.'),
  api: z
    .object({
      source: z.enum(['documented', 'observed', 'both']),
      method: z.enum(['GET', 'POST']),
      urlTemplate: z.string().describe('Absolute URL with {{input}} path placeholders and no query.'),
      queryParams: z.record(z.string(), z.string()).describe('Query parameter name to input name.'),
      fixedQuery: z.record(z.string(), z.string()).optional().describe('Query parameters sent as observed, e.g. queryName=Search.'),
      graphql: z
        .object({
          operationName: z.string(),
          query: z.string(),
          variables: z.record(z.string(), z.unknown()).describe('Variables template; string values may contain {{input}} placeholders.'),
          optionalVariables: z.record(z.string(), z.string()).optional().describe('GraphQL variable name to input name; sent only when the input is provided.'),
          optionalInputs: z.array(z.lazy(() => CapabilityInput)).optional().describe('Inputs that only the API variant accepts.'),
        })
        .optional(),
      documentedOperationId: z.string().optional(),
      specUrl: z.string().optional(),
      candidateId: z.string().optional(),
      authRequired: z.boolean(),
      credentialed: z.boolean().describe('Observed requests carried credentials WebMorph may not replay; such an API is never promoted.'),
      credentialRef: z.string().optional().describe('Name of the operator-configured credential the observed requests carried as their only credential. The http tool resolves it from the site config at run time; the value is never stored.'),
      responseShape: z.object({ kind: z.enum(['object', 'array', 'other']), keys: z.array(z.string()).optional(), itemKeys: z.array(z.string()).optional() }).optional(),
    })
    .optional()
    .describe('A JSON API behind the same capability, when documentation or observed traffic revealed one.'),
});
export type CapabilityMechanics = z.infer<typeof CapabilityMechanics>;

export const Capability = z.object({
  capabilityId: z.string(),
  kind: CapabilityKind,
  name: z.string().describe('snake_case tool-style name.'),
  title: z.string(),
  description: z.string(),
  status: z.enum(['observed', 'inferred']),
  confidence: z.number().min(0).max(1),
  pageUrl: z.string(),
  pageTypeId: z.string().optional(),
  entity: z.string().optional(),
  inputs: z.array(CapabilityInput),
  outputs: z.array(CapabilityOutput),
  preconditions: z.array(z.string()),
  expectedOutcome: z.string(),
  sideEffectClass: z.enum(['read', 'write', 'consequential']),
  authRequirement: z.enum(['none', 'session']),
  mechanics: CapabilityMechanics,
  evidence: z.array(EvidenceRef),
  source: z.enum(['heuristic', 'model']).optional().describe('model: proposed by the harness and kept only after a generated tool validated by replay (D26).'),
});
export type Capability = z.infer<typeof Capability>;

/** What the stage 8 model harness did: every tool call, every proposal and its verdict, and what it cost. */
export const AgentRecord = z.object({
  applied: z.boolean(),
  model: z.string().optional(),
  turns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  toolCalls: z.array(z.object({ turn: z.number().int(), tool: z.string(), ok: z.boolean(), note: z.string() })),
  proposals: z.object({
    accepted: z.array(z.string()).describe('Capability names the model proposed that validated by replay.'),
    rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
  }),
  revisions: z.array(z.string()),
  finished: z.boolean().describe('The model called finish; false when a budget ran out or the model stopped on its own.'),
  stoppedBecause: z.string().optional(),
  error: z.string().optional(),
});
export type AgentRecord = z.infer<typeof AgentRecord>;

export const WebsiteModelData = z.object({
  site: z.object({
    origin: z.string(),
    title: z.string().optional(),
    purpose: z.object({ statement: z.string(), confidence: z.number().min(0).max(1), source: z.enum(['heuristic', 'model']) }),
    language: z.string().optional(),
    frameworks: z.array(z.string()),
    renderMode: RenderModeKind,
    siteBlocked: z.boolean(),
    robots: z.enum(['found', 'missing', 'error']),
  }),
  pageTypes: z.array(PageType),
  entities: z.array(Entity),
  capabilities: z.array(Capability),
  navigation: z.object({ primaryLinks: z.array(z.object({ text: z.string(), url: z.string() })) }),
  apis: z.array(z.object({ specUrl: z.string(), title: z.string().optional(), operations: z.number().int().nonnegative(), readOperationsWithoutAuth: z.number().int().nonnegative() })).optional(),
  authentication: z.object({
    loginPageUrl: z.string().optional(),
    loginFormId: z.string().optional(),
    sessionAvailable: z.boolean(),
  }),
  facts: z.array(Fact),
  hypotheses: z.array(Hypothesis),
  unresolved: z.array(z.string()),
  enrichment: z.object({
    applied: z.boolean(),
    model: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    rejected: z.array(z.string()).describe('Model suggestions dropped because they were not grounded in evidence.'),
    error: z.string().optional(),
  }),
  agent: AgentRecord.optional().describe('Present when the stage 8 model harness ran (D26).'),
});
export type WebsiteModelData = z.infer<typeof WebsiteModelData>;

export const WebsiteModel = defineArtifact('WebsiteModel', WebsiteModelData);
export type WebsiteModel = z.infer<typeof WebsiteModel>;
