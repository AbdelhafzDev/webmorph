import { z } from 'zod';
import { BlobRef, defineArtifact } from './common.js';

export const DOCUMENTATION_INDEX_VERSION = '1.0.0';

export const DocSourceKind = z.enum(['llms-txt', 'llms-full', 'openapi', 'markdown', 'html', 'missing', 'error', 'skipped']);

export const DocSource = z.object({
  url: z.string(),
  via: z.enum(['convention', 'homepage-link', 'docs-link']),
  status: z.number().int().optional(),
  kind: DocSourceKind,
  contentType: z.string().optional(),
  title: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  blob: BlobRef.optional(),
  error: z.string().optional(),
});
export type DocSource = z.infer<typeof DocSource>;

export const ApiParameter = z.object({
  name: z.string(),
  in: z.enum(['query', 'path', 'header', 'cookie']),
  required: z.boolean(),
  type: z.string().optional(),
  enum: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type ApiParameter = z.infer<typeof ApiParameter>;

export const ApiOperation = z.object({
  operationId: z.string(),
  method: z.enum(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']),
  path: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  parameters: z.array(ApiParameter),
  hasRequestBody: z.boolean(),
  responseContentTypes: z.array(z.string()),
  responseKeys: z.array(z.string()).describe('Top-level property names of the documented success response, when it is an object.'),
  responseIsArray: z.boolean(),
  authRequired: z.boolean(),
  securitySchemes: z.array(z.string()),
  sideEffectClass: z.enum(['read', 'write']),
});
export type ApiOperation = z.infer<typeof ApiOperation>;

export const ApiSpec = z.object({
  specUrl: z.string(),
  format: z.enum(['openapi3', 'swagger2']),
  title: z.string().optional(),
  version: z.string().optional(),
  servers: z.array(z.string()).describe('Absolute server URLs after resolution against the spec URL.'),
  securitySchemes: z.array(z.object({ name: z.string(), type: z.string(), in: z.string().optional() })),
  operations: z.array(ApiOperation),
  parseWarnings: z.array(z.string()),
});
export type ApiSpec = z.infer<typeof ApiSpec>;

export const LlmsTxt = z.object({
  url: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  sections: z.array(z.object({ heading: z.string(), links: z.array(z.object({ title: z.string(), url: z.string(), note: z.string().optional() })) })),
});

export const DocumentationIndexData = z.object({
  sources: z.array(DocSource),
  llms: LlmsTxt.optional(),
  apis: z.array(ApiSpec),
  docPages: z.array(z.object({ url: z.string(), title: z.string().optional(), headings: z.array(z.string()) })),
  notes: z.array(z.string()),
  stats: z.object({
    requests: z.number().int().nonnegative(),
    found: z.number().int().nonnegative(),
    operations: z.number().int().nonnegative(),
    readOperationsWithoutAuth: z.number().int().nonnegative(),
  }),
});
export type DocumentationIndexData = z.infer<typeof DocumentationIndexData>;

export const DocumentationIndex = defineArtifact('DocumentationIndex', DocumentationIndexData);
export type DocumentationIndex = z.infer<typeof DocumentationIndex>;
