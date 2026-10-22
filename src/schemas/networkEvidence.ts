import { z } from 'zod';
import { defineArtifact } from './common.js';

export const NETWORK_EVIDENCE_VERSION = '1.0.0';
export const API_CANDIDATES_VERSION = '1.0.0';

/** One captured request, redacted at capture time. Raw bodies and credentials are never stored. */
export const NetworkRecord = z.object({
  at: z.iso.datetime(),
  context: z.object({ pageUrl: z.string(), probeId: z.string().optional() }),
  resourceType: z.string(),
  method: z.string(),
  url: z.string().describe('Sensitive query values replaced with [redacted].'),
  status: z.number().int().optional(),
  requestContentType: z.string().optional(),
  responseContentType: z.string().optional(),
  credentialed: z.boolean().describe('The request carried an authorization header or a session-like cookie. Anonymous infrastructure cookies do not count.'),
  credentialHeaders: z.array(z.string()).optional().describe('Lowercase names of authorization-style headers the request carried (authorization, x-api-key, ...), never values. Stage 7 matches them against operator-configured credentials.'),
  cookieNames: z.array(z.string()).optional().describe('Names of cookies sent, never values.'),
  requestBodyKeys: z.array(z.string()).optional(),
  responseShape: z
    .object({
      kind: z.enum(['object', 'array', 'other']),
      keys: z.array(z.string()).optional(),
      itemKeys: z.array(z.string()).optional(),
      length: z.number().int().optional(),
    })
    .optional(),
  bytes: z.number().int().nonnegative().optional(),
  inScope: z.boolean(),
  error: z.string().optional(),
  graphql: z
    .array(z.object({ operationName: z.string().optional(), operationType: z.enum(['query', 'mutation', 'subscription', 'unknown']), query: z.string(), variables: z.record(z.string(), z.unknown()).optional(), variableNames: z.array(z.string()) }))
    .optional()
    .describe('Present for GraphQL requests: the operation(s), query text and redacted variables. A POST that is only queries counts as a read.'),
});
export type NetworkRecord = z.infer<typeof NetworkRecord>;

export const NetworkEvidenceData = z.object({
  evidenceLog: z.string().describe('JSON Lines file with every record, relative to the job directory.'),
  records: z.array(NetworkRecord).describe('XHR, fetch and document requests, capped.'),
  redaction: z.object({ headerAllowlist: z.array(z.string()), queryDenylist: z.array(z.string()), bodiesStored: z.literal(false) }),
  stats: z.object({
    total: z.number().int().nonnegative(),
    byResourceType: z.record(z.string(), z.number().int().nonnegative()),
    inScope: z.number().int().nonnegative(),
    credentialed: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});
export type NetworkEvidenceData = z.infer<typeof NetworkEvidenceData>;

export const NetworkEvidence = defineArtifact('NetworkEvidence', NetworkEvidenceData);
export type NetworkEvidence = z.infer<typeof NetworkEvidence>;

export const ApiCandidate = z.object({
  candidateId: z.string(),
  method: z.string(),
  host: z.string(),
  pathPattern: z.string().describe('Path with {id} placeholders.'),
  queryParams: z.array(z.string()),
  urlTemplate: z.string().describe('Absolute URL with path placeholders and no query.'),
  inScope: z.boolean(),
  sameSite: z.boolean().default(false).describe('Host shares the registrable domain with the site (api.example.com for example.com).'),
  count: z.number().int().positive(),
  statuses: z.array(z.number().int()),
  responseContentTypes: z.array(z.string()),
  responseShape: NetworkRecord.shape.responseShape,
  credentialed: z.boolean().describe('Observed requests carried a credential. False when the only credential was one the operator configured (see configuredCredential). With credentialSource "header" the candidate is never promoted; with "cookie" the cookie-less replay decides (D21).'),
  credentialSource: z.enum(['header', 'cookie']).optional().describe('What made the candidate credentialed: an authorization-style request header (unpromotable without an operator-configured credential, D23) or only a session-like cookie name (promotable; validation replays without cookies and a 401 or 403 fails it).'),
  configuredCredential: z.string().optional().describe('Name of the operator-configured credential the observed requests carried as their only credential. The tool resolves it at run time; the value is never stored here.'),
  seenOn: z.array(z.object({ pageUrl: z.string(), probeId: z.string().optional() })),
  documentedOperationId: z.string().optional(),
  graphql: z.object({ operationName: z.string(), operationType: z.string(), query: z.string(), variableNames: z.array(z.string()), sampleVariables: z.record(z.string(), z.unknown()).optional() }).optional(),
  sideEffectHint: z.enum(['read', 'write']),
  confidence: z.number().min(0).max(1),
  note: z.string(),
});
export type ApiCandidate = z.infer<typeof ApiCandidate>;

export const ApiCandidatesData = z.object({
  candidates: z.array(ApiCandidate),
  stats: z.object({ total: z.number().int().nonnegative(), documented: z.number().int().nonnegative(), readOnlyPublic: z.number().int().nonnegative() }),
});
export type ApiCandidatesData = z.infer<typeof ApiCandidatesData>;

export const ApiCandidates = defineArtifact('ApiCandidates', ApiCandidatesData);
export type ApiCandidates = z.infer<typeof ApiCandidates>;
