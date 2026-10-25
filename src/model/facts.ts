import type { SiteManifest } from '../schemas/siteManifest.js';
import type { URLInventory } from '../schemas/urlInventory.js';
import type { PageInventory } from '../schemas/pageInventory.js';
import type { PageTemplates, PageTemplate } from '../schemas/pageTemplates.js';
import type { CrawlReport } from '../schemas/crawlReport.js';
import type { PageModel } from '../schemas/pageModel.js';
import type { ElementInventory, ElementRecord, FormInventoryRecord } from '../schemas/elementInventory.js';
import type { InteractionEvidence, ProbeRecord } from '../schemas/interactionEvidence.js';
import type { DocumentationIndex, ApiOperation, ApiSpec } from '../schemas/documentationIndex.js';
import type { ApiCandidates, ApiCandidate } from '../schemas/networkEvidence.js';
import type { Capability, CapabilityInput, Entity, EvidenceRef, Fact, Hypothesis, PageType, WebsiteModelData } from '../schemas/websiteModel.js';
import { urlPattern } from '../html/templates.js';
import { shortHash } from '../core/ids.js';
import { entityFromPattern, patternToPathRegex, patternToPathRegexFromSamples, patternToPathTemplate, singularize, snake } from './naming.js';
import { parseGraphQLVariables } from '../net/graphql.js';

export interface ModelSources {
  manifest: SiteManifest;
  inventory: URLInventory;
  pages: PageInventory;
  templates: PageTemplates;
  report: CrawlReport;
  pageModel?: PageModel;
  elements?: ElementInventory;
  evidence?: InteractionEvidence;
  docs?: DocumentationIndex;
  apiCandidates?: ApiCandidates;
}

const KIND_LABEL: Record<PageTemplate['kind'], string> = {
  home: 'Home page',
  documentation: 'Documentation page',
  search: 'Search results',
  listing: 'Listing page',
  detail: 'Detail page',
  article: 'Article',
  auth: 'Authentication page',
  account: 'Account page',
  form: 'Form page',
  legal: 'Legal page',
  other: 'Page',
};

export class FactBook {
  readonly facts: Fact[] = [];
  readonly hypotheses: Hypothesis[] = [];
  fact(statement: string, evidence: EvidenceRef[]): string {
    const factId = `F${this.facts.length + 1}`;
    this.facts.push({ factId, statement, evidence });
    return factId;
  }
  hypothesis(statement: string, confidence: number, basedOn: string[]): string {
    const hypothesisId = `H${this.hypotheses.length + 1}`;
    this.hypotheses.push({ hypothesisId, statement, confidence, basedOn, source: 'heuristic' });
    return hypothesisId;
  }
}

/**
 * Build the website model from evidence alone. Every capability, fact and
 * hypothesis points back at the artifacts that justify it. A model may enrich
 * descriptions afterwards, never the mechanics.
 */
export function buildDeterministicModel(src: ModelSources): WebsiteModelData {
  const book = new FactBook();
  const origin = src.manifest.data.scope.origin;
  const templates = src.templates.data.templates;
  const inspectedUrls = new Set((src.pageModel?.data.pages ?? []).filter((p) => p.outcome === 'ok').map((p) => p.finalUrl));
  const elements = src.elements?.data.elements ?? [];
  const forms = src.elements?.data.forms ?? [];
  const probes = src.evidence?.data.probes ?? [];
  const staticPages = src.pages.data.pages.filter((p) => p.outcome === 'ok' && p.html);

  // Site-level facts
  const home = staticPages.find((p) => p.finalUrl === src.manifest.data.normalizedStartUrl) ?? staticPages[0];
  book.fact(`robots.txt at ${origin} is ${src.inventory.data.robots.status}; ${src.inventory.data.stats.inScope} in-scope URLs discovered (${src.inventory.data.stats.fromSitemap} from sitemaps)`, [
    { artifactType: 'URLInventory', note: 'robots and sitemap discovery' },
  ]);
  book.fact(`Static crawl fetched ${src.report.data.budget.pagesAttempted} pages; dominant render mode ${src.report.data.siteRenderMode}${src.report.data.siteBlocked ? '; site blocked bot access' : ''}`, [
    { artifactType: 'CrawlReport', note: 'crawl summary' },
  ]);
  // Documentation and observed APIs.
  const specs = src.docs?.data.apis ?? [];
  const candidates = src.apiCandidates?.data.candidates ?? [];
  for (const spec of specs) {
    const readPublic = spec.operations.filter((o) => o.sideEffectClass === 'read' && !o.authRequired).length;
    book.fact(`An ${spec.format} description at ${spec.specUrl}${spec.title ? ` ("${spec.title}")` : ''} documents ${spec.operations.length} operation(s), ${readPublic} read-only without authentication`, [{ artifactType: 'DocumentationIndex', refId: spec.specUrl }]);
  }
  if (src.docs?.data.llms) book.fact(`llms.txt at ${src.docs.data.llms.url} lists ${src.docs.data.llms.sections.reduce((n, s) => n + s.links.length, 0)} link(s)`, [{ artifactType: 'DocumentationIndex', refId: src.docs.data.llms.url }]);
  // A candidate flagged only by a cookie name may still become a tool; the cookie-less replay decides (D21).
  const mayReplay = (x: ApiCandidate) => !x.credentialed || x.credentialSource === 'cookie';
  for (const c of candidates.filter((x) => x.inScope && x.sideEffectHint === 'read' && mayReplay(x)).slice(0, 20)) {
    book.fact(`The browser called ${c.method} ${c.urlTemplate}${c.queryParams.length ? `?${c.queryParams.join('&')}` : ''} ${c.count} time(s) during discovery (${c.documentedOperationId ? `documented as ${c.documentedOperationId}` : 'undocumented'}${c.configuredCredential ? `; carried the operator-configured credential "${c.configuredCredential}"` : ''}${c.credentialSource === 'cookie' ? '; carried a session-like cookie, not replayed' : ''})`, [{ artifactType: 'ApiCandidates', refId: c.candidateId }]);
  }
  const apiLinker = new ApiLinker(specs, candidates, book);

  const frameworks = Array.from(new Set(staticPages.flatMap((p) => p.html!.scripts.frameworks))).sort();
  if (frameworks.length) book.fact(`Front-end frameworks detected: ${frameworks.join(', ')}`, staticPages.filter((p) => p.html!.scripts.frameworks.length).slice(0, 3).map((p) => ({ artifactType: 'PageInventory' as const, refId: p.finalUrl })));

  // Page types
  const pageTypes: PageType[] = templates.map((t) => {
    const factId = book.fact(`${t.pageCount} page(s) match ${t.urlPattern} and share a template (${t.kind}, cohesion ${t.cohesion})`, [{ artifactType: 'PageTemplates', refId: t.templateId }]);
    void factId;
    return {
      pageTypeId: t.templateId,
      urlPattern: t.urlPattern,
      kind: t.kind,
      label: KIND_LABEL[t.kind],
      pageCount: t.pageCount,
      representativeUrls: t.representativeUrls,
      inspected: t.urls.some((u) => inspectedUrls.has(u)),
    };
  });
  const templateFact = (t: PageTemplate) => book.facts.find((f) => f.evidence.some((e) => e.refId === t.templateId))!.factId;

  // Entities from detail-like templates
  const entities: Entity[] = [];
  const entityByTemplate = new Map<string, Entity>();
  for (const t of templates.filter((x) => x.kind === 'detail' || x.kind === 'article')) {
    const derived = entityFromPattern(t.urlPattern);
    if (!derived) continue;
    let entity = entities.find((e) => e.name === derived.singular);
    if (!entity) {
      entity = {
        entityId: `ent-${shortHash(derived.singular, 8)}`,
        name: derived.singular,
        plural: derived.plural,
        detailPageTypeId: t.templateId,
        listPageTypeIds: [],
        identifierSegment: derived.identifierSegment,
        confidence: 0.7,
        source: 'heuristic',
      };
      entities.push(entity);
      book.hypothesis(`Pages matching ${t.urlPattern} each describe a single ${derived.singular}`, 0.7, [templateFact(t)]);
    }
    entityByTemplate.set(t.templateId, entity);
  }

  // Which detail template do a page's links point at?
  const detailTemplates = templates.filter((t) => entityByTemplate.has(t.templateId));
  const dominantDetailTemplate = (hrefs: string[]): PageTemplate | undefined => {
    const counts = new Map<string, number>();
    for (const href of hrefs) {
      const p = urlPattern(href);
      for (const t of detailTemplates) {
        if (p === t.urlPattern.split('?')[0]) counts.set(t.templateId, (counts.get(t.templateId) ?? 0) + 1);
      }
    }
    const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < 2) return undefined;
    return detailTemplates.find((t) => t.templateId === best[0]);
  };
  const staticLinksOf = (url: string): string[] => staticPages.find((p) => p.finalUrl === url || p.requestedUrl === url)?.html?.links.filter((l) => l.inScope).map((l) => l.href) ?? [];
  const browserLinksOf = (url: string): string[] => elements.filter((e) => e.pageUrl === url && e.kind === 'link' && e.attributes.href).map((e) => e.attributes.href!);
  const linksOf = (url: string): string[] => {
    const b = browserLinksOf(url);
    return b.length ? b : staticLinksOf(url);
  };

  const capabilities: Capability[] = [];
  const usedNames = new Set<string>();
  const uniqueName = (base: string): string => {
    let name = base;
    let i = 2;
    while (usedNames.has(name)) name = `${base}_${i++}`;
    usedNames.add(name);
    return name;
  };
  const elementById = new Map(elements.map((e) => [e.elementId, e]));

  // Search capabilities from GET search forms
  const seenSearch = new Set<string>();
  for (const form of forms.filter((f) => f.classification === 'search' && f.method === 'get' && !f.hasSensitiveFields)) {
    const field = form.fieldElementIds.map((id) => elementById.get(id)).find((e) => e && (e.kind === 'searchbox' || e.kind === 'textbox'));
    if (!field) continue;
    const key = `${form.action}|${field.attributes.name ?? field.locators[0]?.value ?? field.elementId}`;
    if (seenSearch.has(key)) continue;
    seenSearch.add(key);
    const probe = probes.find((p) => p.kind === 'search-submit' && p.outcome === 'navigated' && (p.targetElementId === field.elementId || p.action.locator.value === field.locators[0]?.value));
    if (!field.attributes.name && !probe) continue; // a nameless field needs observed evidence of where the search goes
    const cap = buildSearchCapability({ form, field, probe, origin, book, templates, entityByTemplate, dominantDetailTemplate, linksOf, uniqueName });
    if (!cap) continue;
    // The same site-wide search reached from several pages is one capability.
    const same = capabilities.find((c) => c.kind === 'search' && c.mechanics.navigateUrl === cap.mechanics.navigateUrl && c.mechanics.pathTemplate === cap.mechanics.pathTemplate && JSON.stringify(c.mechanics.queryParams) === JSON.stringify(cap.mechanics.queryParams));
    if (same) {
      usedNames.delete(cap.name);
      for (const ev of cap.evidence) if (!same.evidence.some((e) => e.refId === ev.refId)) same.evidence.push(ev);
      continue;
    }
    apiLinker.linkSearch(cap, probe, field.attributes.name ?? 'q');
    capabilities.push(cap);
  }

  // How often crawled pages link to each URL: the most-linked member of a family (a popular brand, not an
  // obscure one the sampler happened to fetch) is the example a listing tool ships with.
  const inbound = new Map<string, number>();
  for (const p of staticPages) for (const l of p.html!.links) if (l.inScope) inbound.set(l.href, (inbound.get(l.href) ?? 0) + 1);
  for (const e of elements) if (e.kind === 'link' && e.attributes.href) inbound.set(e.attributes.href, (inbound.get(e.attributes.href) ?? 0) + 1);
  const preferredExample = (t: PageTemplate): string | undefined => {
    const re = new RegExp(patternToPathRegex(t.urlPattern));
    let best: { url: string; count: number } | undefined;
    const consider = (url: string) => {
      let pathname: string;
      try {
        pathname = new URL(url).pathname;
      } catch {
        return;
      }
      if (!re.test(pathname)) return;
      const count = inbound.get(url) ?? 0;
      if (!best || count > best.count) best = { url, count };
    };
    for (const url of t.urls) consider(url);
    for (const url of inbound.keys()) consider(url);
    return best?.count ? best.url : undefined;
  };

  // Listing capabilities. Templates that differ only by query (/products and /products?page) describe one listing.
  for (const t of templates.filter((x) => x.kind === 'listing').sort((x, y) => Number(x.urlPattern.includes('?')) - Number(y.urlPattern.includes('?')) || y.pageCount - x.pageCount)) {
    const cap = buildListCapability({ template: t, origin, book, probes, elementById, forms, entityByTemplate, dominantDetailTemplate, linksOf, uniqueName, templateFact, inspectedUrls, preferredExample });
    if (!cap) continue;
    const entity = entities.find((e) => e.name === cap.entity);
    if (entity && !entity.listPageTypeIds.includes(t.templateId)) entity.listPageTypeIds.push(t.templateId);
    apiLinker.linkList(cap, entity);
    const existing = capabilities.find((c) => c.kind === 'list' && c.mechanics.navigateUrl === cap.mechanics.navigateUrl && c.mechanics.pathTemplate === cap.mechanics.pathTemplate && c.entity === cap.entity);
    if (existing) {
      usedNames.delete(cap.name);
      for (const input of cap.inputs) if (!existing.inputs.some((i) => i.name === input.name)) existing.inputs.push(input);
      existing.mechanics.queryParams = { ...(existing.mechanics.queryParams ?? {}), ...(cap.mechanics.queryParams ?? {}) };
      for (const ev of cap.evidence) if (!existing.evidence.some((e) => e.refId === ev.refId && e.artifactType === ev.artifactType)) existing.evidence.push(ev);
      existing.description = `Open ${new URL(existing.mechanics.navigateUrl!).pathname} and return the ${entity?.plural.replace(/_/g, ' ') ?? 'items'} it links to${existing.inputs.length ? `, optionally with ${existing.inputs.map((i) => i.name).join(' and ')}` : ''}.`;
      continue;
    }
    capabilities.push(cap);
  }

  // Detail capabilities
  for (const [templateId, entity] of entityByTemplate) {
    const t = templates.find((x) => x.templateId === templateId)!;
    const { template, inputs } = patternToPathTemplate(t.urlPattern);
    const example = t.representativeUrls[0];
    // Decoded: the interpreter encodes path inputs when it renders the template, so an encoded example would be encoded twice.
    const exampleSegments = example
      ? new URL(example).pathname.split('/').filter(Boolean).map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        })
      : [];
    const patternSegments = (t.urlPattern.split('?')[0] ?? '').split('/').filter(Boolean);
    const capInputs: CapabilityInput[] = inputs.map((inp) => {
      const idx = patternSegments.indexOf(inp.segment);
      const ex = idx >= 0 ? exampleSegments[idx]?.replace(/\.[a-z0-9]+$/i, '') : undefined;
      return { name: inp.name, type: 'string', required: true, source: 'path-segment', description: `${inp.segment === '{id}' ? 'Identifier' : 'Slug'} of the ${entity.name}`, ...(ex ? { example: ex } : {}) };
    });
    const factId = templateFact(t);
    const detailCap: Capability = {
      capabilityId: `cap-${shortHash(`detail|${t.templateId}`, 10)}`,
      kind: 'detail',
      name: uniqueName(`get_${entity.name}`),
      title: `Get ${entity.name.replace(/_/g, ' ')}`,
      description: `Open a ${entity.name.replace(/_/g, ' ')} page matching ${t.urlPattern} and read its title, heading and text.`,
      status: inspectedUrls.has(example ?? '') ? 'observed' : 'inferred',
      confidence: inspectedUrls.has(example ?? '') ? 0.8 : 0.6,
      pageUrl: example ?? origin,
      pageTypeId: t.templateId,
      entity: entity.name,
      inputs: capInputs,
      outputs: [
        { name: 'title', type: 'string' },
        { name: 'heading', type: 'string' },
        { name: 'description', type: 'string' },
        { name: 'text', type: 'string', description: 'Main content text, truncated' },
        { name: 'url', type: 'string' },
      ],
      preconditions: ['page is publicly reachable'],
      expectedOutcome: `A ${entity.name.replace(/_/g, ' ')} page renders with a non-empty title`,
      sideEffectClass: 'read',
      authRequirement: 'none',
      mechanics: { navigateUrl: origin, pathTemplate: template },
      evidence: [{ artifactType: 'PageTemplates', refId: t.templateId, note: `fact ${factId}` }, ...(example ? [{ artifactType: 'PageInventory' as const, refId: example }] : [])],
    };
    apiLinker.linkDetail(detailCap, entity, example);
    capabilities.push(detailCap);
  }

  // Authentication facts
  const loginForm = forms.find((f) => f.classification === 'login');
  const staticLogin = loginForm ? undefined : staticPages.find((p) => p.html!.forms.some((f) => f.classification === 'login'));
  if (loginForm) {
    book.fact(`A login form on ${loginForm.pageUrl} posts to ${loginForm.action} (password field present)`, [{ artifactType: 'ElementInventory', refId: loginForm.formId }]);
  } else if (staticLogin) {
    const f = staticLogin.html!.forms.find((x) => x.classification === 'login')!;
    book.fact(`A login form on ${staticLogin.finalUrl} posts to ${f.action} (password field present)`, [{ artifactType: 'PageInventory', refId: staticLogin.finalUrl }]);
  }
  const loginPageUrl = loginForm?.pageUrl ?? staticLogin?.finalUrl;
  const consent = (src.pageModel?.data.pages ?? []).find((p) => p.dialogs.some((d) => d.kind === 'consent'));
  if (consent) {
    const d = consent.dialogs.find((x) => x.kind === 'consent')!;
    book.fact(`A cookie-consent dialog appears on ${consent.finalUrl} with buttons ${d.buttonNames.map((b) => `"${b}"`).join(', ')}; it was not dismissed`, [{ artifactType: 'PageModel', refId: consent.finalUrl }]);
  }
  for (const p of (src.pageModel?.data.pages ?? []).filter((x) => x.outcome === 'ok' && x.hydration.delta !== undefined && x.hydration.delta >= 100)) {
    book.fact(`Browser rendering added ${p.hydration.delta} characters of text on ${p.finalUrl} beyond the static HTML`, [{ artifactType: 'PageModel', refId: p.finalUrl }]);
  }

  // Navigation
  const navLinks = (home ? home.html!.links.filter((l) => l.inScope && l.text) : []).slice(0, 40);
  const primaryLinks = elements.filter((e) => e.pageUrl === home?.finalUrl && e.kind === 'link' && e.region === 'navigation' && e.attributes.href && e.name).map((e) => ({ text: e.name!, url: e.attributes.href! }));
  const navigation = { primaryLinks: (primaryLinks.length ? primaryLinks : navLinks.map((l) => ({ text: l.text, url: l.href }))).slice(0, 30) };

  const unresolved: string[] = [];
  if (!src.pageModel) unresolved.push('No browser inspection evidence; capabilities rest on static HTML only');
  if (capabilities.some((c) => c.kind === 'search') && !capabilities.some((c) => c.kind === 'search' && c.mechanics.resultLinkPattern)) unresolved.push('Search results structure could not be tied to a detail page type');
  if (loginPageUrl) unresolved.push('Pages behind authentication were not explored (no session configured)');
  for (const c of candidates.filter((x) => x.inScope && x.sideEffectHint === 'read' && mayReplay(x) && !capabilities.some((cap) => cap.mechanics.api?.candidateId === x.candidateId))) unresolved.push(`Observed API ${c.method} ${c.urlTemplate} is not tied to a capability`);
  for (const c of capabilities.filter((x) => x.kind === 'list' && x.inputs.some((i) => i.enum))) unresolved.push(`Meaning of filter options on ${c.pageUrl} is not verified`);
  disambiguateByLocale(capabilities, src.manifest.data.normalizedStartUrl);

  return {
    site: {
      origin,
      title: home?.html?.title,
      purpose: { statement: `Website at ${origin}${home?.html?.title ? ` titled "${home.html.title}"` : ''}${entities.length ? ` with ${entities.map((e) => e.plural).join(', ')}` : ''}`, confidence: 0.4, source: 'heuristic' },
      language: home?.html?.lang,
      frameworks,
      renderMode: src.report.data.siteRenderMode,
      siteBlocked: src.report.data.siteBlocked,
      robots: src.inventory.data.robots.status,
    },
    pageTypes,
    entities,
    capabilities,
    navigation,
    apis: specs.map((s) => ({ specUrl: s.specUrl, ...(s.title ? { title: s.title } : {}), operations: s.operations.length, readOperationsWithoutAuth: s.operations.filter((o) => o.sideEffectClass === 'read' && !o.authRequired).length })),
    authentication: {
      ...(loginPageUrl ? { loginPageUrl } : {}),
      ...(loginForm ? { loginFormId: loginForm.formId } : {}),
      sessionAvailable: src.manifest.data.auth.mode === 'session',
    },
    facts: book.facts,
    hypotheses: book.hypotheses,
    unresolved,
    enrichment: { applied: false, rejected: [] },
  };
}

interface SearchArgs {
  form: FormInventoryRecord;
  field: ElementRecord;
  probe?: ProbeRecord;
  origin: string;
  book: FactBook;
  templates: PageTemplate[];
  entityByTemplate: Map<string, Entity>;
  dominantDetailTemplate: (hrefs: string[]) => PageTemplate | undefined;
  linksOf: (url: string) => string[];
  uniqueName: (base: string) => string;
}

function buildSearchCapability(a: SearchArgs): Capability | null {
  const { form, field, probe, book } = a;
  const param = field.attributes.name ?? 'q';
  const evidence: EvidenceRef[] = [{ artifactType: 'ElementInventory', refId: form.formId, note: 'search form' }, { artifactType: 'ElementInventory', refId: field.elementId, note: 'query field' }];
  const f1 = book.fact(`A search form on ${form.pageUrl} submits GET to ${form.action}${field.attributes.name ? ` with field "${param}"` : ' from an unnamed field'}`, evidence.slice(0, 1));
  const basedOn = [f1];

  let directUrl = false;
  let resultsUrl: string | undefined;
  // Where the typed value showed up in the landing URL: a query parameter, or a path segment (/search/{{query}}).
  let landingParam: string | undefined;
  let landingPathTemplate: string | undefined;
  if (probe?.after) {
    resultsUrl = probe.after.url;
    const after = new URL(probe.after.url);
    const action = new URL(form.action);
    const typed = probe.action.value ?? '';
    for (const [k, v] of after.searchParams) if (typed && v === typed) landingParam = k;
    if (!landingParam && typed) {
      const segs = after.pathname.split('/');
      const idx = segs.findIndex((s) => decodeURIComponent(s) === typed);
      if (idx >= 0) landingPathTemplate = segs.map((s, i) => (i === idx ? '{{query}}' : s)).join('/');
    }
    directUrl = Boolean(landingParam) && after.origin === action.origin && after.pathname === action.pathname;
    basedOn.push(book.fact(`Submitting "${typed}" in that form navigated to ${probe.after.url}`, [{ artifactType: 'InteractionEvidence', refId: probe.probeId }]));
    evidence.push({ artifactType: 'InteractionEvidence', refId: probe.probeId, note: 'search submission observed' });
  }
  if (!field.attributes.name && !landingParam && !landingPathTemplate) return null;

  // Results page type and the detail links it carries.
  const resultsPattern = resultsUrl ? urlPattern(resultsUrl) : undefined;
  const resultsTemplate = resultsPattern ? a.templates.find((t) => t.urlPattern === resultsPattern || t.urlPattern.split('?')[0] === resultsPattern.split('?')[0]) : undefined;
  let detail: PageTemplate | undefined;
  let detailNote = '';
  let assumed = false;
  // Links that appeared with the results: the landing page's links minus those the form's page already had
  // (navigation, brand chips, footer). Falls back to all landing links when nothing is new.
  const beforeLinks = new Set(probe?.before?.links ?? []);
  const newLinks = (probe?.after?.links ?? []).filter((l) => !beforeLinks.has(l));
  const resultLinks = newLinks.length >= 3 ? newLinks : (probe?.after?.links ?? []);
  if (resultLinks.length) {
    detail = a.dominantDetailTemplate(resultLinks);
    if (detail) {
      detailNote = `Results page ${probe!.after!.url} links to pages matching ${detail.urlPattern}`;
      basedOn.push(book.fact(detailNote, [{ artifactType: 'InteractionEvidence', refId: probe!.probeId, note: 'links on the landing page' }]));
    }
  }
  if (!detail && resultsTemplate) {
    for (const sample of resultsTemplate.urls) {
      detail = a.dominantDetailTemplate(a.linksOf(sample));
      if (detail) {
        basedOn.push(book.fact(`Results page ${sample} links to pages matching ${detail.urlPattern}`, [{ artifactType: 'PageInventory', refId: sample }]));
        break;
      }
    }
  }
  // The landing page's own links are the best evidence of what a result looks like; a crawled template
  // that matches none of them (a locale prefix, a different section) must not override them.
  let landingPattern: string | undefined;
  let templateMatches = 0;
  if (detail && resultLinks.length) {
    const re = new RegExp(patternToPathRegex(detail.urlPattern));
    templateMatches = resultLinks.filter((l) => {
      try {
        return re.test(new URL(l).pathname);
      } catch {
        return false;
      }
    }).length;
    if (templateMatches === 0) detail = undefined;
  }
  if (resultLinks.length) {
    const counts = new Map<string, number>();
    for (const href of resultLinks) {
      const p = urlPattern(href).split('?')[0] ?? '';
      if (p.includes('{')) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    // Among patterns with enough hits to be the result shape, prefer one carrying an identifier; a single stray
    // /channel/{id} link must not outrank ten /cardetail/{slug} results.
    const entries = Array.from(counts.entries());
    const ranked = entries.filter(([, n]) => n >= 3).sort((x, y) => Number(y[0].includes('{id}')) - Number(x[0].includes('{id}')) || y[1] - x[1]);
    const best = ranked[0] ?? entries.sort((x, y) => y[1] - x[1])[0];
    // A crawled template that explains fewer of the result links than the dominant new link shape loses to it:
    // the crawl may never have reached the pages search actually returns.
    if (detail && best && best[1] >= 3 && best[1] > templateMatches * 2 && best[0] !== detail.urlPattern.split('?')[0]) detail = undefined;
    if (!detail && best && best[1] >= 3) {
      landingPattern = best[0];
      // The same pages under a locale prefix: /en/{id}/{slug} is the crawled /{id}/{slug} template.
      const stripLocale = (p: string) => p.replace(/^\/[a-z]{2}(?=\/)/, '');
      const viaLocale = a.templates.find((t) => a.entityByTemplate.has(t.templateId) && stripLocale(t.urlPattern.split('?')[0] ?? '') === stripLocale(landingPattern!));
      if (viaLocale) detail = viaLocale;
      basedOn.push(book.fact(`Results page ${probe!.after!.url} links ${best[1]} times to pages matching ${landingPattern}`, [{ artifactType: 'InteractionEvidence', refId: probe!.probeId, note: 'links on the landing page' }]));
    }
  }
  if (!detail && !landingPattern) {
    // No results page with hits was observed; assume the site's dominant entity and let validation decide.
    const candidates = Array.from(a.entityByTemplate.keys()).map((id) => a.templates.find((t) => t.templateId === id)!).sort((x, y) => y.pageCount - x.pageCount);
    detail = candidates[0];
    assumed = Boolean(detail);
  }
  const entity = detail ? a.entityByTemplate.get(detail.templateId) : undefined;
  const confidence = probe ? (detail && !assumed ? 0.8 : 0.55) : 0.45;
  const hyp = book.hypothesis(entity ? `Searching returns ${entity.plural} whose pages match ${detail!.urlPattern}` : 'Searching returns a list of matching pages', confidence, basedOn);
  void hyp;

  const action = new URL(form.action);
  const landing = resultsUrl ? new URL(resultsUrl) : undefined;
  const navigateUrl = landingPathTemplate ? undefined : landingParam && landing ? `${landing.origin}${landing.pathname}` : `${action.origin}${action.pathname}`;
  const effectiveParam = landingParam ?? param;
  return {
    capabilityId: `cap-${shortHash(`search|${form.action}|${effectiveParam}|${landingPathTemplate ?? ''}`, 10)}`,
    kind: 'search',
    name: a.uniqueName(entity ? `search_${entity.plural}` : 'search_site'),
    title: entity ? `Search ${entity.plural.replace(/_/g, ' ')}` : 'Search the site',
    description: entity ? `Search for ${entity.plural.replace(/_/g, ' ')} by keyword and return matching result links.` : 'Search the site by keyword and return matching result links.',
    status: probe ? 'observed' : 'inferred',
    confidence,
    pageUrl: form.pageUrl,
    entity: entity?.name,
    inputs: [{ name: 'query', type: 'string', required: true, source: landingPathTemplate ? 'path-segment' : directUrl || landingParam ? 'url-param' : 'form-field', param: effectiveParam, description: 'Search keywords', ...(probe?.action.value ? { example: probe.action.value } : {}) }],
    outputs: [
      { name: 'results', type: 'array', description: 'Result links with title and url' },
      { name: 'count', type: 'integer' },
      { name: 'pageUrl', type: 'string' },
    ],
    preconditions: ['search form is present on the page'],
    expectedOutcome: `Navigates to ${landingPathTemplate ?? landing?.pathname ?? action.pathname} and shows result links${entity ? ` to ${entity.plural.replace(/_/g, ' ')}` : ''}`,
    sideEffectClass: 'read',
    authRequirement: 'none',
    mechanics: {
      formId: form.formId,
      fieldElementIds: [field.elementId],
      submitElementId: form.submitElementId,
      action: form.action,
      method: 'get',
      ...(navigateUrl ? { navigateUrl } : { navigateUrl: landing!.origin }),
      ...(landingPathTemplate ? { pathTemplate: landingPathTemplate } : {}),
      queryParams: landingPathTemplate ? {} : { [effectiveParam]: 'query' },
      directUrlObserved: directUrl || Boolean(landingPathTemplate) || Boolean(landingParam),
      ...(landingPattern ? { resultLinkPattern: patternToPathRegexFromSamples(landingPattern, (probe?.after?.links ?? []).filter((l) => (urlPattern(l).split('?')[0] ?? '') === landingPattern)) } : detail ? { resultLinkPattern: patternToPathRegexFromSamples(detail.urlPattern, detail.urls) } : {}),
      ...(resultsTemplate ? { resultsPageTypeId: resultsTemplate.templateId } : {}),
    },
    evidence: [...evidence, ...(detail ? [{ artifactType: 'PageTemplates' as const, refId: detail.templateId, note: assumed ? 'result link pattern assumed from the dominant detail template; unverified' : 'result link pattern' }] : [])],
  };
}

interface ListArgs {
  template: PageTemplate;
  origin: string;
  book: FactBook;
  probes: ProbeRecord[];
  elementById: Map<string, ElementRecord>;
  forms: FormInventoryRecord[];
  entityByTemplate: Map<string, Entity>;
  dominantDetailTemplate: (hrefs: string[]) => PageTemplate | undefined;
  linksOf: (url: string) => string[];
  uniqueName: (base: string) => string;
  templateFact: (t: PageTemplate) => string;
  inspectedUrls: Set<string>;
  /** The member of a template most linked to from crawled pages: the example a listing tool should ship with. */
  preferredExample: (t: PageTemplate) => string | undefined;
}

function buildListCapability(a: ListArgs): Capability | null {
  const { template: t, book } = a;
  const rep = [...t.representativeUrls].sort((x, y) => Number(x.includes('?')) - Number(y.includes('?')))[0];
  if (!rep) return null;
  const detail = a.dominantDetailTemplate(a.linksOf(rep));
  if (!detail) return null;
  const entity = a.entityByTemplate.get(detail.templateId);
  if (!entity) return null;
  const base = new URL(rep);
  const basedOn = [a.templateFact(t), book.fact(`${rep} links to pages matching ${detail.urlPattern}`, [{ artifactType: 'PageInventory', refId: rep }])];
  const evidence: EvidenceRef[] = [{ artifactType: 'PageTemplates', refId: t.templateId }, { artifactType: 'PageInventory', refId: rep, note: 'listing page' }];
  const inputs: CapabilityInput[] = [];
  const queryParams: Record<string, string> = {};

  // A listing per category (/autos/{slug}, /city/{slug}): each placeholder is a required path input,
  // named after the literal segment before it when there is one.
  const { template: pathTemplate, inputs: pathInputs } = patternToPathTemplate(t.urlPattern);
  const patternSegments = (t.urlPattern.split('?')[0] ?? '').split('/').filter(Boolean);
  const exampleUrl = a.preferredExample(t) ?? rep;
  const repSegments = new URL(exampleUrl).pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  let byLabel = '';
  const originalNames = pathInputs.map((inp) => inp.name);
  if (pathInputs.length) {
    const used = new Set<string>();
    for (const inp of pathInputs) {
      const idx = patternSegments.indexOf(inp.segment);
      const parent = idx > 0 ? patternSegments[idx - 1]! : '';
      let name = parent && !parent.startsWith('{') ? singularize(snake(parent)) : inp.name;
      if (!name || used.has(name)) name = inp.name;
      used.add(name);
      if (!byLabel && parent && !parent.startsWith('{')) byLabel = `_by_${snake(parent)}`;
      inp.name = name;
      const example = idx >= 0 ? repSegments[idx] : undefined;
      inputs.push({ name, type: 'string', required: true, source: 'path-segment', description: `${parent ? `${parent} ` : ''}path segment of the listing page`, ...(example ? { example } : {}) });
    }
  }
  const renderedTemplate = originalNames.reduce((tpl, original, i) => tpl.replace(`{{${original}}}`, `{{${pathInputs[i]!.name}}}`), pathTemplate);
  const navigateUrl = pathInputs.length ? base.origin : `${base.origin}${base.pathname}`;

  // Pagination observed?
  const pager = a.probes.find((p) => p.kind === 'pagination' && p.outcome === 'navigated' && p.after && p.before && new URL(p.before.url).pathname === base.pathname);
  if (pager?.after) {
    const before = new URL(pager.before!.url);
    const after = new URL(pager.after.url);
    const param = Array.from(after.searchParams.keys()).find((k) => after.searchParams.get(k) !== before.searchParams.get(k) && /^\d+$/.test(after.searchParams.get(k) ?? ''));
    if (param) {
      inputs.push({ name: 'page', type: 'integer', required: false, source: 'url-param', param, description: 'Page number, starting at 1', minimum: 1, example: after.searchParams.get(param) ?? '2' });
      queryParams[param] = 'page';
      basedOn.push(book.fact(`The "next" link on ${pager.before!.url} navigates to ${pager.after.url} (parameter "${param}")`, [{ artifactType: 'InteractionEvidence', refId: pager.probeId }]));
      evidence.push({ artifactType: 'InteractionEvidence', refId: pager.probeId, note: 'pagination observed' });
    }
  }

  // Filters: GET form selects on this page.
  for (const form of a.forms.filter((f) => f.pageUrl === rep && f.method === 'get' && f.classification !== 'search' && !f.hasSensitiveFields)) {
    for (const select of form.fieldElementIds.map((id) => a.elementById.get(id)).filter((e): e is ElementRecord => Boolean(e && e.kind === 'select' && e.attributes.name && e.options?.length))) {
      const param = select.attributes.name!;
      const probe = a.probes.find((p) => p.kind === 'filter-change' && p.targetElementId === select.elementId && p.outcome === 'navigated' && p.after && new URL(p.after.url).searchParams.has(param));
      inputs.push({
        name: snake(param) || 'filter',
        type: 'string',
        required: false,
        source: 'url-param',
        param,
        description: select.name ? `${select.name}` : `Filter "${param}"`,
        enum: select.options!.map((o) => o.value).filter(Boolean),
        ...(probe?.after ? { example: new URL(probe.after.url).searchParams.get(param) ?? undefined } : {}),
      });
      queryParams[param] = snake(param) || 'filter';
      if (probe?.after) {
        basedOn.push(book.fact(`Changing "${select.name ?? param}" on ${rep} navigated to ${probe.after.url}`, [{ artifactType: 'InteractionEvidence', refId: probe.probeId }]));
        evidence.push({ artifactType: 'InteractionEvidence', refId: probe.probeId, note: 'filter change observed' });
      } else {
        evidence.push({ artifactType: 'ElementInventory', refId: select.elementId, note: 'filter select (not probed)' });
      }
    }
  }

  const observed = a.inspectedUrls.has(rep);
  book.hypothesis(`${rep} lists ${entity.plural}${inputs.some((i) => i.name === 'page') ? ', paginated' : ''}${inputs.some((i) => i.enum) ? ', with filters' : ''}`, observed ? 0.75 : 0.55, basedOn);
  const suffix = t.urlPattern.includes('?') ? `_${snake(t.urlPattern.split('?')[1] ?? '')}` : '';
  const optionalInputs = inputs.filter((i) => !i.required);
  return {
    capabilityId: `cap-${shortHash(`list|${t.templateId}`, 10)}`,
    kind: 'list',
    name: a.uniqueName(`list_${entity.plural}${byLabel}${suffix && !inputs.some((i) => i.name === 'page') ? suffix : ''}`),
    title: `List ${entity.plural.replace(/_/g, ' ')}${byLabel ? ` by ${byLabel.slice(4).replace(/_/g, ' ')}` : ''}`,
    description: `Open ${pathInputs.length ? renderedTemplate : base.pathname} and return the ${entity.plural.replace(/_/g, ' ')} it links to${optionalInputs.length ? `, optionally with ${optionalInputs.map((i) => i.name).join(' and ')}` : ''}.`,
    status: observed ? 'observed' : 'inferred',
    confidence: observed ? 0.75 : 0.55,
    pageUrl: rep,
    pageTypeId: t.templateId,
    entity: entity.name,
    inputs,
    outputs: [
      { name: 'results', type: 'array', description: 'Linked items with title and url' },
      { name: 'count', type: 'integer' },
      { name: 'pageUrl', type: 'string' },
    ],
    preconditions: ['listing page is publicly reachable'],
    expectedOutcome: `A listing of ${entity.plural.replace(/_/g, ' ')} with links matching ${detail.urlPattern}`,
    sideEffectClass: 'read',
    authRequirement: 'none',
    mechanics: { navigateUrl, ...(pathInputs.length ? { pathTemplate: renderedTemplate } : {}), queryParams, resultLinkPattern: patternToPathRegexFromSamples(detail.urlPattern, detail.urls), resultsPageTypeId: t.templateId },
    evidence: [...evidence, { artifactType: 'PageTemplates', refId: detail.templateId, note: 'result link pattern' }],
  };
}

const SEARCH_PARAM = /^(q|query|search|s|term|keyword|keywords|text)$/i;
const SUGGEST_PATH = /suggest|autocomplete|typeahead|complete|hint/i;

/**
 * Ties capabilities to JSON APIs from two kinds of evidence: documented
 * operations and traffic observed while the browser exercised the capability.
 * Authenticated APIs and APIs credentialed by header are recorded but never
 * promoted; one credentialed only by a cookie name is promoted and settled by
 * the cookie-less replay (D21).
 */
export class ApiLinker {
  private readonly ops: Array<{ spec: ApiSpec; op: ApiOperation }>;
  constructor(
    specs: ApiSpec[],
    private readonly candidates: ApiCandidate[],
    private readonly book: FactBook,
  ) {
    this.ops = specs.flatMap((spec) => spec.operations.filter((op) => op.method === 'get').map((op) => ({ spec, op })));
  }

  private attach(cap: Capability, api: NonNullable<Capability['mechanics']['api']>, note: string): void {
    cap.mechanics.api = api;
    if (api.documentedOperationId && api.specUrl) cap.evidence.push({ artifactType: 'DocumentationIndex', refId: api.documentedOperationId, note: `documented at ${api.specUrl}` });
    if (api.candidateId) cap.evidence.push({ artifactType: 'ApiCandidates', refId: api.candidateId, note });
    this.book.hypothesis(`${cap.name} can be served by ${api.method} ${api.urlTemplate} (${api.source})`, api.source === 'both' ? 0.8 : api.source === 'observed' ? 0.65 : 0.5, this.book.facts.filter((f) => f.evidence.some((e) => e.refId === api.candidateId || e.refId === api.specUrl)).map((f) => f.factId));
  }

  private documented(pred: (op: ApiOperation) => boolean): { spec: ApiSpec; op: ApiOperation } | undefined {
    return this.ops.find(({ op }) => pred(op));
  }

  private urlFor(spec: ApiSpec, op: ApiOperation): string {
    const server = spec.servers[0] ?? '';
    return `${server}${op.path.replace(/\{([^}]+)\}/g, (_, n: string) => `{{${snake(n) || 'id'}}}`)}`;
  }

  /**
   * For a capability proposed without an API (the model named a page): the same evidence the deterministic model
   * uses attaches one. A search gets the endpoint that carried a search probe's typed text (GraphQL or REST), mapped
   * onto the capability's own input; a listing or a detail gets the documented or observed endpoint named after its
   * entity. Returns a note for the model when something was attached.
   */
  linkProposed(cap: Capability, probes: ProbeRecord[], inputName: string, entity: Entity | undefined): string | undefined {
    const apiOf = (c: Capability) => c.mechanics.api; // read through a call: the link methods assign it, which narrowing would not see
    if (apiOf(cap)) return undefined;
    if (cap.kind === 'list') {
      this.linkList(cap, entity);
      const api = apiOf(cap);
      return api ? `the harness attached the site's own ${api.method} ${api.urlTemplate} endpoint (${api.source}) for this listing; the HTTP tool carries the capability's name and the page route is the fallback` : undefined;
    }
    if (cap.kind === 'detail') {
      if (entity) this.linkDetail(cap, entity, cap.pageUrl);
      const api = apiOf(cap);
      return api ? `the harness attached the site's own ${api.method} ${api.urlTemplate} endpoint (${api.source}) for this detail; the HTTP tool carries the capability's name and the page route is the fallback` : undefined;
    }
    const candidates = probes.filter((p) => p.kind === 'search-submit' && p.action.value);
    for (const probe of candidates) {
      this.linkSearch(cap, probe, inputName);
      const api = apiOf(cap);
      if (!api) continue;
      // linkSearch templates the probe's value as {{query}}; the proposal's input keeps its own name.
      if (inputName !== 'query') {
        if (api.graphql) api.graphql.variables = JSON.parse(JSON.stringify(api.graphql.variables).replaceAll('{{query}}', `{{${inputName}}}`)) as Record<string, unknown>;
        api.queryParams = Object.fromEntries(Object.entries(api.queryParams).map(([k, v]) => [k, v === 'query' ? inputName : v]));
      }
      return `the harness attached the site's own ${api.graphql ? `GraphQL ${api.graphql.operationName}` : `${api.method} ${api.urlTemplate}`} endpoint, observed when the search probe typed "${probe.action.value}"; the HTTP tool carries the capability's name and the page route is the fallback`;
    }
    return undefined;
  }

  linkSearch(cap: Capability, probe: ProbeRecord | undefined, fieldName: string): void {
    const typed = probe?.action.value;
    // GraphQL: the query whose variables carried what the probe typed is the search operation.
    const gql = probe && typed ? this.candidates.find((c) => (c.inScope || c.sameSite) && c.sideEffectHint === 'read' && c.graphql && c.seenOn.some((s) => s.probeId === probe.probeId) && JSON.stringify(c.graphql.sampleVariables ?? {}).includes(JSON.stringify(typed).slice(1, -1))) : undefined;
    if (gql?.graphql) {
      const template = templateVariables(gql.graphql.sampleVariables ?? {}, typed!, 'query');
      // Other declared variables with scalar or list-of-scalar types become optional inputs.
      const optionalVariables: Record<string, string> = {};
      const optionalInputs: CapabilityInput[] = [];
      const templated = new Set(Object.entries(template).filter(([, v]) => JSON.stringify(v).includes('{{')).map(([k]) => k));
      for (const decl of parseGraphQLVariables(gql.graphql.query)) {
        if (!decl.kind || templated.has(decl.name) || /token|auth|session|client/i.test(decl.name)) continue;
        const inputName = snake(decl.name) || decl.name;
        if (cap.inputs.some((i) => i.name === inputName) || optionalInputs.some((i) => i.name === inputName)) continue;
        const observed = decl.name in template && typeof template[decl.name] !== 'object' ? String(template[decl.name]) : undefined;
        optionalInputs.push({ name: inputName, type: decl.kind, ...(decl.items ? { items: decl.items } : {}), required: false, source: 'url-param', param: decl.name, description: `GraphQL variable $${decl.name} (${decl.type})${observed !== undefined ? `; observed ${observed}` : ''}` });
        optionalVariables[decl.name] = inputName;
      }
      this.attach(cap, {
        source: 'observed',
        method: 'POST',
        urlTemplate: gql.urlTemplate,
        queryParams: {},
        ...(gql.queryParams.length ? { fixedQuery: Object.fromEntries(gql.queryParams.filter((k) => /^(queryName|operationName|op)$/i.test(k)).map((k) => [k, gql.graphql!.operationName])) } : {}),
        graphql: { operationName: gql.graphql.operationName, query: gql.graphql.query, variables: template, ...(Object.keys(optionalVariables).length ? { optionalVariables, optionalInputs } : {}) },
        candidateId: gql.candidateId,
        authRequired: false,
        credentialed: gql.credentialed,
        ...(gql.credentialSource ? { credentialSource: gql.credentialSource } : {}),
        ...(gql.configuredCredential ? { credentialRef: gql.configuredCredential } : {}),
        ...(gql.responseShape ? { responseShape: gql.responseShape } : {}),
      }, `GraphQL ${gql.graphql.operationName} carried the typed query during the search probe`);
      return;
    }
    // Several requests may carry the typed text; a suggestion endpoint (autosuggest, typeahead) is not the results API.
    const observed = probe
      ? this.candidates
          .filter((c) => (c.inScope || c.sameSite) && c.sideEffectHint === 'read' && !c.graphql && c.seenOn.some((s) => s.probeId === probe.probeId) && c.queryParams.some((p) => SEARCH_PARAM.test(p) || p === fieldName))
          .sort((x, y) => Number(SUGGEST_PATH.test(x.pathPattern)) - Number(SUGGEST_PATH.test(y.pathPattern)) || Number(y.queryParams.includes(fieldName)) - Number(x.queryParams.includes(fieldName)) || y.count - x.count)[0]
      : undefined;
    const doc = this.documented((op) => op.parameters.some((p) => p.in === 'query' && (SEARCH_PARAM.test(p.name) || p.name === fieldName)) && !op.parameters.some((p) => p.in === 'path'));
    if (!observed && !doc) return;
    const param = observed?.queryParams.find((p) => p === fieldName || SEARCH_PARAM.test(p)) ?? doc!.op.parameters.find((p) => p.in === 'query' && (p.name === fieldName || SEARCH_PARAM.test(p.name)))!.name;
    const docMatch = doc && observed?.documentedOperationId ? doc.op.operationId === observed.documentedOperationId : Boolean(doc);
    this.attach(cap, {
      source: observed && docMatch ? 'both' : observed ? 'observed' : 'documented',
      method: 'GET',
      urlTemplate: observed?.urlTemplate ?? this.urlFor(doc!.spec, doc!.op),
      queryParams: { [param]: 'query' },
      ...(doc && docMatch ? { documentedOperationId: doc.op.operationId, specUrl: doc.spec.specUrl } : {}),
      ...(observed ? { candidateId: observed.candidateId } : {}),
      authRequired: doc && docMatch ? doc.op.authRequired : false,
      credentialed: observed?.credentialed ?? false,
      ...(observed?.credentialSource ? { credentialSource: observed.credentialSource } : {}),
      ...(observed?.configuredCredential ? { credentialRef: observed.configuredCredential } : {}),
      ...(observed?.responseShape ? { responseShape: observed.responseShape } : {}),
    }, 'search request observed during the search probe');
  }

  linkList(cap: Capability, entity: Entity | undefined): void {
    if (!entity) return;
    const plural = entity.plural.replace(/_/g, '-');
    const endsWithPlural = (path: string) => new RegExp(`/${plural.replace(/-/g, '[-_]?')}/?$`, 'i').test(path);
    const observed = this.candidates.find((c) => (c.inScope || c.sameSite) && c.sideEffectHint === 'read' && !c.graphql && !c.pathPattern.includes('{') && endsWithPlural(c.pathPattern) && c.seenOn.some((s) => s.pageUrl === cap.pageUrl));
    const doc = this.documented((op) => !op.parameters.some((p) => p.in === 'path') && endsWithPlural(op.path));
    if (!observed && !doc) return;
    const queryParams: Record<string, string> = {};
    for (const input of cap.inputs) if (input.param && (observed?.queryParams.includes(input.param) || doc?.op.parameters.some((p) => p.in === 'query' && p.name === input.param))) queryParams[input.param] = input.name;
    const docMatch = doc && observed?.documentedOperationId ? doc.op.operationId === observed.documentedOperationId : Boolean(doc);
    this.attach(cap, {
      source: observed && docMatch ? 'both' : observed ? 'observed' : 'documented',
      method: 'GET',
      urlTemplate: observed?.urlTemplate ?? this.urlFor(doc!.spec, doc!.op),
      queryParams,
      ...(doc && docMatch ? { documentedOperationId: doc.op.operationId, specUrl: doc.spec.specUrl } : {}),
      ...(observed ? { candidateId: observed.candidateId } : {}),
      authRequired: doc && docMatch ? doc.op.authRequired : false,
      credentialed: observed?.credentialed ?? false,
      ...(observed?.credentialSource ? { credentialSource: observed.credentialSource } : {}),
      ...(observed?.configuredCredential ? { credentialRef: observed.configuredCredential } : {}),
      ...(observed?.responseShape ? { responseShape: observed.responseShape } : {}),
    }, 'listing request observed on the listing page');
  }

  linkDetail(cap: Capability, entity: Entity, exampleUrl: string | undefined): void {
    const plural = entity.plural.replace(/_/g, '-');
    const detailPath = new RegExp(`/${plural.replace(/-/g, '[-_]?')}/\\{[^}]+\\}/?$`, 'i');
    const observed = this.candidates.find((c) => (c.inScope || c.sameSite) && c.sideEffectHint === 'read' && !c.graphql && detailPath.test(c.pathPattern) && (!exampleUrl || c.seenOn.some((s) => s.pageUrl === exampleUrl || true)));
    const doc = this.documented((op) => op.parameters.filter((p) => p.in === 'path').length === 1 && detailPath.test(op.path));
    if (!observed && !doc) return;
    const inputName = cap.inputs[0]?.name ?? 'id';
    const urlTemplate = (observed?.urlTemplate ?? this.urlFor(doc!.spec, doc!.op)).replace(/\{\{[^}]+\}\}/, `{{${inputName}}}`);
    const docMatch = doc && observed?.documentedOperationId ? doc.op.operationId === observed.documentedOperationId : Boolean(doc);
    this.attach(cap, {
      source: observed && docMatch ? 'both' : observed ? 'observed' : 'documented',
      method: 'GET',
      urlTemplate,
      queryParams: {},
      ...(doc && docMatch ? { documentedOperationId: doc.op.operationId, specUrl: doc.spec.specUrl } : {}),
      ...(observed ? { candidateId: observed.candidateId } : {}),
      authRequired: doc && docMatch ? doc.op.authRequired : false,
      credentialed: observed?.credentialed ?? false,
      ...(observed?.credentialSource ? { credentialSource: observed.credentialSource } : {}),
      ...(observed?.configuredCredential ? { credentialRef: observed.configuredCredential } : {}),
      ...(observed?.responseShape ? { responseShape: observed.responseShape } : {}),
    }, 'detail request observed');
  }
}

/** Replace occurrences of the typed value in sample variables with an {{input}} placeholder; other values stay as constants. */
/** Locale prefix of a URL path (/en/..., /ar-sa/...) or undefined. */
function localeOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const first = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
    return /^[a-z]{2}(-[a-z]{2})?$/i.test(first) ? first.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * search_cars and search_cars_2 that differ only by locale prefix become search_cars and search_cars_ar:
 * the variant matching the start URL's locale (or without one) keeps the base name.
 */
export function disambiguateByLocale(capabilities: Capability[], startUrl: string): void {
  const siteLocale = localeOf(startUrl);
  const groups = new Map<string, Capability[]>();
  for (const cap of capabilities) {
    const base = cap.name.replace(/_\d+$/, '');
    const group = groups.get(base) ?? [];
    group.push(cap);
    groups.set(base, group);
  }
  const taken = new Set(capabilities.map((c) => c.name));
  for (const [base, group] of groups) {
    if (group.length < 2) continue;
    const locales = group.map((cap) => localeOf(cap.mechanics.navigateUrl && cap.mechanics.pathTemplate ? cap.mechanics.navigateUrl + cap.mechanics.pathTemplate : cap.mechanics.navigateUrl) ?? localeOf(cap.pageUrl));
    if (new Set(locales).size < 2) continue;
    const keeper = group.find((_, i) => locales[i] === siteLocale) ?? group.find((_, i) => locales[i] === undefined) ?? group[0]!;
    for (const cap of group) taken.delete(cap.name);
    const assign = (cap: Capability, name: string) => {
      let candidate = name;
      let i = 2;
      while (taken.has(candidate)) candidate = `${name}_${i++}`;
      taken.add(candidate);
      cap.name = candidate;
    };
    assign(keeper, base);
    group.forEach((cap, i) => {
      if (cap === keeper) return;
      assign(cap, locales[i] ? `${base}_${locales[i]!.replace('-', '_')}` : base);
    });
  }
}

function templateVariables(sample: Record<string, unknown>, typed: string, inputName: string): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v === typed ? `{{${inputName}}}` : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(sample) as Record<string, unknown>;
}
