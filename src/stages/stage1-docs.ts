import type { StageDefinition } from '../core/job.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { DocumentationIndex, DOCUMENTATION_INDEX_VERSION, type ApiSpec, type DocSource, type DocumentationIndexData } from '../schemas/documentationIndex.js';
import { extractHtmlFacts } from '../html/extract.js';
import { decodeHtml } from '../html/charset.js';
import { parseOpenApi } from '../docs/openapi.js';
import { parseLlmsTxt } from '../docs/llms.js';
import { normalizeUrl, FETCH_NORMALIZE } from '../net/url.js';
import { createHttpClient, makeEnvelope, refTo, scopeFromManifest, type DiscoveryInput } from './shared.js';

const CONVENTIONAL: Array<{ path: string; expect: 'llms-txt' | 'llms-full' | 'openapi' | 'any' }> = [
  { path: '/llms.txt', expect: 'llms-txt' },
  { path: '/llms-full.txt', expect: 'llms-full' },
  { path: '/openapi.json', expect: 'openapi' },
  { path: '/openapi.yaml', expect: 'openapi' },
  { path: '/swagger.json', expect: 'openapi' },
  { path: '/swagger.yaml', expect: 'openapi' },
  { path: '/api/openapi.json', expect: 'openapi' },
  { path: '/api/swagger.json', expect: 'openapi' },
  { path: '/.well-known/openapi.json', expect: 'openapi' },
  { path: '/api-docs', expect: 'any' },
  { path: '/docs', expect: 'any' },
  { path: '/developer', expect: 'any' },
  { path: '/developers', expect: 'any' },
  { path: '/reference', expect: 'any' },
  { path: '/api', expect: 'any' },
];
const DOC_LINK = /\b(docs?|documentation|developers?|api|reference|swagger|openapi|llms)\b/i;
const ACCEPT = 'application/json,application/yaml,text/yaml,text/markdown,text/plain,text/html;q=0.9,*/*;q=0.5';

/**
 * Stage 1: public documentation before any interactive exploration. Conventions
 * are candidates, not guarantees. Everything found is site-controlled input:
 * recorded as evidence, never treated as proof of behavior.
 */
export const stage1Docs: StageDefinition<DiscoveryInput> = {
  id: 'stage1-docs',
  produces: ['DocumentationIndex'],
  requires: ['stage0-scope'],
  optional: true,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const { scope: scopeData, budget } = manifest.data;
    const scope = scopeFromManifest(manifest.data);
    const http = createHttpClient(manifest.data, ctx.input);
    const origin = scopeData.origin;
    const sources: DocSource[] = [];
    const apis: ApiSpec[] = [];
    const docPages: DocumentationIndexData['docPages'] = [];
    const notes: string[] = ['Documentation is published by the site and may be stale or wrong; capabilities derived from it are hypotheses until validated.'];
    let llms: DocumentationIndexData['llms'];
    const seen = new Set<string>();
    const queue: Array<{ url: string; via: DocSource['via']; expect: 'llms-txt' | 'llms-full' | 'openapi' | 'any' }> = [];
    const enqueue = (url: string | null, via: DocSource['via'], expect: 'llms-txt' | 'llms-full' | 'openapi' | 'any' = 'any') => {
      if (!url || seen.has(url) || !scope.isInScope(url) || scope.isProhibitedPath(url)) return;
      seen.add(url);
      queue.push({ url, via, expect });
    };

    try {
      for (const c of CONVENTIONAL) enqueue(normalizeUrl(origin + c.path, undefined, FETCH_NORMALIZE), 'convention', c.expect);

      // Documentation links on the homepage.
      const home = await http.fetch(manifest.data.normalizedStartUrl, { accept: 'text/html', acceptTypes: /text\/html|xhtml/i });
      if (home.ok && home.status === 200 && !home.bodySkipped) {
        const facts = extractHtmlFacts(decodeHtml(home.body, home.contentType).text, { finalUrl: home.finalUrl, scope, maxLinks: 500 });
        for (const link of facts.links) {
          if (link.inScope && (DOC_LINK.test(link.text) || DOC_LINK.test(new URL(link.href).pathname))) enqueue(link.observed ?? link.href, 'homepage-link');
        }
      }

      let requests = 0;
      while (queue.length > 0 && requests < budget.maxDocRequests) {
        const item = queue.shift()!;
        requests += 1;
        const res = await http.fetch(item.url, { accept: ACCEPT, acceptTypes: /json|yaml|markdown|text\/plain|text\/html|xhtml/i });
        if (!res.ok) {
          sources.push({ url: item.url, via: item.via, kind: 'error', error: `${res.kind}: ${res.message}` });
          continue;
        }
        if (res.status === 404 || res.status === 410 || res.status === 403 || res.status === 401) {
          sources.push({ url: item.url, via: item.via, status: res.status, kind: 'missing' });
          continue;
        }
        if (res.status !== 200 || res.bodySkipped) {
          sources.push({ url: item.url, via: item.via, status: res.status, kind: 'error', contentType: res.contentType, error: res.bodySkipped ? 'unexpected content type' : `HTTP ${res.status}` });
          continue;
        }
        const { text } = decodeHtml(res.body, res.contentType);
        const ct = res.contentType ?? '';
        const pathname = new URL(res.finalUrl).pathname;
        const base: DocSource = { url: res.finalUrl, via: item.via, status: res.status, kind: 'html', contentType: ct, bytes: res.body.length };

        // OpenAPI first: JSON or YAML bodies, whatever the URL said.
        const spec = /json|yaml|text\/plain/i.test(ct) || /\.(json|ya?ml)$/i.test(pathname) ? parseOpenApi(text, res.finalUrl) : null;
        if (spec) {
          const blob = await ctx.store.writeBlob(ctx.siteId, ctx.jobId, 'docs', ct || 'application/json', res.body, /yaml/i.test(ct) || /\.ya?ml$/i.test(pathname) ? '.yaml' : '.json');
          sources.push({ ...base, kind: 'openapi', title: spec.title, blob });
          apis.push(spec);
          ctx.logger.info(`docs: ${spec.format} at ${res.finalUrl}: ${spec.operations.length} operations`);
          continue;
        }
        if (/llms(-full)?\.txt$/i.test(pathname) || (item.expect === 'llms-txt' && /markdown|text\/plain/i.test(ct))) {
          const parsed = parseLlmsTxt(text, res.finalUrl);
          const blob = await ctx.store.writeBlob(ctx.siteId, ctx.jobId, 'docs', 'text/markdown', res.body, '.md');
          const kind = /llms-full/i.test(pathname) ? 'llms-full' : 'llms-txt';
          sources.push({ ...base, kind, title: parsed.title, blob });
          if (kind === 'llms-txt' || !llms) llms = parsed;
          for (const section of parsed.sections) for (const link of section.links) if (/openapi|swagger|api/i.test(link.url) || /\.(json|ya?ml)$/i.test(link.url)) enqueue(normalizeUrl(link.url, undefined, FETCH_NORMALIZE), 'docs-link', 'openapi');
          ctx.logger.info(`docs: ${kind} at ${res.finalUrl}: ${parsed.sections.reduce((n, s) => n + s.links.length, 0)} links`);
          continue;
        }
        if (/markdown/i.test(ct) || /\.md$/i.test(pathname)) {
          const blob = await ctx.store.writeBlob(ctx.siteId, ctx.jobId, 'docs', 'text/markdown', res.body, '.md');
          sources.push({ ...base, kind: 'markdown', title: text.match(/^#\s+(.+)$/m)?.[1]?.trim(), blob });
          continue;
        }
        if (/html/i.test(ct) && (item.expect === 'openapi' || item.expect === 'llms-txt' || item.expect === 'llms-full')) {
          // An HTML answer at a machine-readable path is a soft 404: single-page apps answer every path.
          sources.push({ ...base, kind: 'missing', error: 'soft 404: HTML answered a machine-readable path' });
          continue;
        }
        if (/html/i.test(ct)) {
          const facts = extractHtmlFacts(text, { finalUrl: res.finalUrl, scope, maxLinks: 300 });
          sources.push({ ...base, kind: 'html', title: facts.title });
          docPages.push({ url: res.finalUrl, title: facts.title, headings: facts.headings.slice(0, 15).map((h) => h.text) });
          // Follow links that look like machine-readable specs, one level only.
          if (item.via !== 'docs-link') {
            for (const link of facts.links) if (link.inScope && (/openapi|swagger/i.test(link.href) || /\.(json|ya?ml)$/i.test(new URL(link.href).pathname))) enqueue(link.observed ?? link.href, 'docs-link', 'openapi');
          }
          continue;
        }
        sources.push({ ...base, kind: 'error', error: `unrecognized content type ${ct}` });
      }
      for (const left of queue) sources.push({ url: left.url, via: left.via, kind: 'skipped', error: 'maxDocRequests reached' });

      const operations = apis.flatMap((a) => a.operations);
      const data: DocumentationIndexData = {
        sources,
        ...(llms ? { llms } : {}),
        apis,
        docPages,
        notes,
        stats: {
          requests,
          found: sources.filter((s) => ['llms-txt', 'llms-full', 'openapi', 'markdown', 'html'].includes(s.kind)).length,
          operations: operations.length,
          readOperationsWithoutAuth: operations.filter((o) => o.sideEffectClass === 'read' && !o.authRequired).length,
        },
      };
      ctx.logger.info(`docs: ${data.stats.found} source(s) found in ${requests} request(s), ${data.stats.operations} documented operations`);
      return [DocumentationIndex.parse({ ...makeEnvelope({ type: 'DocumentationIndex', schemaVersion: DOCUMENTATION_INDEX_VERSION, siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage1-docs', sources: [refTo(manifest)], now: ctx.now }), data })];
    } finally {
      await http.close();
    }
  },
};
