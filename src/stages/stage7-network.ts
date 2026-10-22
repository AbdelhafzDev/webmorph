import { readFile } from 'node:fs/promises';
import type { StageDefinition } from '../core/job.js';
import { shortHash } from '../core/ids.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { DocumentationIndex } from '../schemas/documentationIndex.js';
import { ApiCandidates, API_CANDIDATES_VERSION, NetworkEvidence, NETWORK_EVIDENCE_VERSION, NetworkRecord, type ApiCandidate, type ApiCandidatesData, type NetworkEvidenceData } from '../schemas/networkEvidence.js';
import { HEADER_ALLOWLIST, QUERY_DENYLIST, hasAuthCookie } from '../net/redact.js';
import { findCredentialFor } from '../schemas/siteConfig.js';
import { matchesDocumentedPath } from '../docs/openapi.js';
import { classifySegment } from '../html/templates.js';
import { sameSite, hostnameOf } from '../net/url.js';
import { makeEnvelope, refTo, type DiscoveryInput } from './shared.js';
import type { ArtifactRef } from '../schemas/common.js';

/**
 * Stage 7: turn the network evidence captured during inspection and probes
 * into API candidates. Candidates are hypotheses for review; nothing here is
 * replayed, and credentialed requests are never promoted. A request whose only
 * credential is a header the operator configured for that host (D23) counts
 * as configured instead: the candidate names the credential, never its value.
 */
export const stage7Network: StageDefinition<DiscoveryInput> = {
  id: 'stage7-network',
  produces: ['NetworkEvidence', 'ApiCandidates'],
  requires: ['stage5-inspect'],
  optional: true,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const docs = (await ctx.hasArtifact('DocumentationIndex')) ? await ctx.artifact('DocumentationIndex', DocumentationIndex) : undefined;
    const { budget } = manifest.data;
    const logPath = ctx.store.evidencePath(ctx.siteId, ctx.jobId, 'network');
    let raw = '';
    try {
      raw = await readFile(logPath, 'utf8');
    } catch {
      raw = '';
    }
    const all = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => NetworkRecord.safeParse(JSON.parse(line)))
      .filter((r) => r.success)
      .map((r) => r.data);
    const records = all.slice(0, budget.maxNetworkRecords);

    // Name of the configured credential that explains every credential a record carried; undefined when
    // the record carried none, an unconfigured header, an auth-like cookie, or headers of two credentials.
    const configuredRefs = manifest.data.auth.apiCredentials;
    const configuredFor = (r: NetworkRecord): string | undefined => {
      if (!r.credentialed || !configuredRefs.length) return undefined;
      if (hasAuthCookie(r.cookieNames ?? [])) return undefined;
      const headers = r.credentialHeaders ?? [];
      if (!headers.length) return undefined;
      let target: URL;
      try {
        target = new URL(r.url);
      } catch {
        return undefined;
      }
      const names = new Set(headers.map((h) => findCredentialFor(configuredRefs, target, h)?.name));
      if (names.has(undefined) || names.size !== 1) return undefined;
      return Array.from(names)[0];
    };

    const byResourceType: Record<string, number> = {};
    for (const r of all) byResourceType[r.resourceType] = (byResourceType[r.resourceType] ?? 0) + 1;
    const evidenceData: NetworkEvidenceData = {
      evidenceLog: 'evidence/network.jsonl',
      records,
      redaction: { headerAllowlist: HEADER_ALLOWLIST, queryDenylist: QUERY_DENYLIST, bodiesStored: false },
      stats: { total: all.length, byResourceType, inScope: all.filter((r) => r.inScope).length, credentialed: all.filter((r) => r.credentialed).length, truncated: all.length > records.length },
    };

    // Group API-like traffic into candidates.
    const groups = new Map<string, { records: NetworkRecord[]; method: string; host: string; pathPattern: string; queryParams: string[]; urlTemplate: string; inScope: boolean }>();
    for (const r of all) {
      if (r.resourceType !== 'xhr' && r.resourceType !== 'fetch') continue;
      if (r.error) continue;
      let u: URL;
      try {
        u = new URL(r.url);
      } catch {
        continue;
      }
      const segments = u.pathname.split('/').filter(Boolean).map(classifySegment);
      const pathPattern = '/' + segments.join('/');
      const gql = r.graphql?.[0];
      const queryParams = Array.from(new Set(Array.from(u.searchParams.keys()))).filter((k) => !gql || !/^(clientid|client_id|lang|locale)$/i.test(k) || k === 'queryName').sort();
      const key = `${r.method} ${u.host}${pathPattern}?${queryParams.join(',')}${gql ? `#${gql.operationName ?? gql.query.slice(0, 40)}` : ''}`;
      const g = groups.get(key) ?? { records: [], method: r.method, host: u.host, pathPattern, queryParams, urlTemplate: `${u.origin}${pathPattern.replace(/\{(id|slug)\}/g, '{{$1}}')}`, inScope: r.inScope };
      g.records.push(r);
      groups.set(key, g);
    }

    const operations = (docs?.data.apis ?? []).flatMap((spec) => spec.operations.map((op) => ({ spec, op })));
    const documentedFor = (method: string, url: string): string | undefined => {
      for (const { spec, op } of operations) {
        if (op.method.toUpperCase() !== method) continue;
        for (const server of spec.servers) {
          if (!url.startsWith(server)) continue;
          const rel = url.slice(server.length).split('?')[0] ?? '';
          if (matchesDocumentedPath(rel.startsWith('/') ? rel : `/${rel}`, op.path)) return op.operationId;
        }
      }
      return undefined;
    };

    const candidates: ApiCandidate[] = [];
    for (const g of groups.values()) {
      const sample = g.records.find((r) => r.status !== undefined && r.status < 300) ?? g.records[0]!;
      const statuses = Array.from(new Set(g.records.map((r) => r.status).filter((s): s is number => s !== undefined))).sort();
      const documentedOperationId = documentedFor(g.method, sample.url);
      const configured = g.records.map((r) => ({ record: r, name: configuredFor(r) }));
      const credentialed = configured.some(({ record, name }) => record.credentialed && !name);
      const configuredNames = new Set(configured.map(({ name }) => name).filter((n): n is string => Boolean(n)));
      const configuredCredential = !credentialed && configuredNames.size === 1 ? Array.from(configuredNames)[0] : undefined;
      const gqlSample = g.records.map((r) => r.graphql?.[0]).find((x) => x);
      const graphqlRead = Boolean(gqlSample) && g.records.every((r) => r.graphql?.every((x) => x.operationType === 'query'));
      const read = g.method === 'GET' || g.method === 'HEAD' || graphqlRead;
      const allOk = statuses.length > 0 && statuses.every((s) => s < 300);
      const seenOn = Array.from(new Map(g.records.map((r) => [`${r.context.pageUrl}|${r.context.probeId ?? ''}`, r.context])).values()).slice(0, 20);
      candidates.push({
        candidateId: `api-${shortHash(`${g.method} ${g.urlTemplate}?${g.queryParams.join(',')}`, 10)}`,
        method: g.method,
        host: g.host,
        pathPattern: g.pathPattern,
        queryParams: g.queryParams,
        urlTemplate: g.urlTemplate,
        inScope: g.inScope,
        sameSite: g.inScope || sameSite(g.host.split(':')[0]!, hostnameOf(manifest.data.scope.origin)),
        count: g.records.length,
        statuses,
        responseContentTypes: Array.from(new Set(g.records.map((r) => r.responseContentType).filter((x): x is string => Boolean(x)))),
        ...(sample.responseShape ? { responseShape: sample.responseShape } : {}),
        credentialed,
        ...(configuredCredential ? { configuredCredential } : {}),
        seenOn,
        ...(documentedOperationId ? { documentedOperationId } : {}),
        ...(gqlSample ? { graphql: { operationName: gqlSample.operationName ?? 'anonymous', operationType: gqlSample.operationType, query: gqlSample.query, variableNames: gqlSample.variableNames, ...(gqlSample.variables ? { sampleVariables: gqlSample.variables } : {}) } } : {}),
        sideEffectHint: read ? 'read' : 'write',
        confidence: documentedOperationId && allOk ? 0.8 : allOk ? 0.6 : 0.35,
        note: `${documentedOperationId ? 'documented and observed' : 'observed only'} during discovery; not replayed${credentialed ? '; carried credentials, never promoted' : configuredCredential ? `; carried the operator-configured credential "${configuredCredential}" (sent at run time, never stored)` : ''}${gqlSample ? `; GraphQL ${gqlSample.operationType}${graphqlRead ? ' (read)' : ''}` : ''}`,
      });
    }
    candidates.sort((a, b) => b.confidence - a.confidence || b.count - a.count);
    const candidatesData: ApiCandidatesData = {
      candidates,
      stats: { total: candidates.length, documented: candidates.filter((c) => c.documentedOperationId).length, readOnlyPublic: candidates.filter((c) => c.sideEffectHint === 'read' && !c.credentialed && (c.inScope || c.sameSite)).length },
    };
    const configuredCount = candidates.filter((c) => c.configuredCredential).length;
    ctx.logger.info(`network: ${all.length} records, ${candidates.length} API candidate(s), ${candidatesData.stats.documented} documented${configuredCount ? `, ${configuredCount} using an operator-configured credential` : ''}`);

    const sources: ArtifactRef[] = [refTo(manifest), ...(docs ? [refTo(docs)] : [])];
    const common = { siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage7-network' as const, now: ctx.now, sources };
    const evidence = NetworkEvidence.parse({ ...makeEnvelope({ ...common, type: 'NetworkEvidence', schemaVersion: NETWORK_EVIDENCE_VERSION }), data: evidenceData });
    const apiCandidates = ApiCandidates.parse({ ...makeEnvelope({ ...common, type: 'ApiCandidates', schemaVersion: API_CANDIDATES_VERSION, sources: [...sources, refTo(evidence)] }), data: candidatesData });
    return [evidence, apiCandidates];
  },
};
