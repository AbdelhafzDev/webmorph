import type { Logger } from '../core/job.js';
import { extractPageData, type PageData } from '../html/pageData.js';
import { extractListData, type ListData } from '../html/listData.js';
import type { SafeHttpClient } from '../net/http.js';
import { hostnameOf } from '../net/url.js';
import type { Capability, WebsiteModelData } from '../schemas/websiteModel.js';

/**
 * A page read once during tool generation. For a detail capability it is the page the page-data tool reads, so that
 * tool can describe the embedded JSON it returns. For a listing or search capability it is the landing page with the
 * example inputs, read without a browser: when the results are already in the HTML, the capability gets an HTTP tool.
 */
export interface PageSample {
  url: string;
  data: PageData;
  /** Result links and ItemList entries found in the HTML of a listing or search landing page. */
  list?: ListData;
}

/** The page a capability's page-data tool reads with its example inputs; undefined when the capability gets no such tool or has no example. */
export function pageDataSampleUrl(cap: Capability): string | undefined {
  const m = cap.mechanics;
  if (cap.kind !== 'detail' || !m.navigateUrl || !m.pathTemplate || m.api) return undefined;
  return renderExampleUrl(cap, m.navigateUrl, m.pathTemplate, {});
}

/**
 * The landing page a listing or search tool opens with its example inputs: the path template rendered, plus the
 * query parameters that carry inputs. Undefined without a navigate URL or when an input has no example.
 */
export function listSampleUrl(cap: Capability): string | undefined {
  const m = cap.mechanics;
  if ((cap.kind !== 'list' && cap.kind !== 'search') || !m.navigateUrl || !m.resultLinkPattern) return undefined;
  return renderExampleUrl(cap, m.navigateUrl, m.pathTemplate ?? '', m.queryParams ?? {});
}

function renderExampleUrl(cap: Capability, navigateUrl: string, pathTemplate: string, queryParams: Record<string, string>): string | undefined {
  let missing = false;
  const exampleOf = (name: string, source?: Capability['inputs'][number]['source']): string | undefined => {
    const input = cap.inputs.find((i) => i.name === name && (!source || i.source === source));
    return input?.example !== undefined ? String(input.example) : undefined;
  };
  const path = pathTemplate.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, name: string) => {
    const example = exampleOf(name, 'path-segment');
    if (example === undefined) {
      missing = true;
      return '';
    }
    return encodeURIComponent(example);
  });
  if (missing) return undefined;
  const url = new URL(`${navigateUrl}${path}`);
  for (const [param, inputName] of Object.entries(queryParams)) {
    const example = exampleOf(inputName);
    const input = cap.inputs.find((i) => i.name === inputName);
    if (example === undefined) {
      if (input?.required) return undefined;
      continue;
    }
    url.searchParams.set(param, example);
  }
  return url.toString();
}

/**
 * Fetch each capability's sample page once through the safe HTTP client. The crawl keeps no HTML, so this is the one
 * read the generator makes per capability; failures are logged and skipped, and the tools are still generated, a
 * page-data tool without a described shape and a listing without its HTTP variant.
 */
export async function samplePageData(model: WebsiteModelData, http: SafeHttpClient, options: { logger?: Logger; signal?: AbortSignal; maxItems?: number } = {}): Promise<Record<string, PageSample>> {
  const samples: Record<string, PageSample> = {};
  const origin = model.site.origin;
  for (const cap of model.capabilities) {
    if (options.signal?.aborted) break;
    if (cap.sideEffectClass !== 'read') continue;
    const listUrl = listSampleUrl(cap);
    const url = listUrl ?? pageDataSampleUrl(cap);
    if (!url) continue;
    const res = await http.fetch(url, { accept: 'text/html,application/xhtml+xml', acceptTypes: /html|xml/i, signal: options.signal });
    if (!res.ok) {
      options.logger?.debug(`generate: sample page ${url} not read (${res.kind}: ${res.message})`);
      continue;
    }
    if (res.status >= 400 || res.bodySkipped) {
      options.logger?.debug(`generate: sample page ${url} answered ${res.status}${res.bodySkipped ? ' without HTML' : ''}`);
      continue;
    }
    // Decoded the way the extractors will decode it at call time, so the shapes match the tools' own output.
    const html = res.body.toString('utf8');
    const sample: PageSample = { url: res.finalUrl, data: extractPageData(html) };
    if (listUrl && cap.mechanics.resultLinkPattern) {
      const pageHost = hostnameOf(res.finalUrl);
      sample.list = extractListData(html, {
        pageUrl: res.finalUrl,
        hrefPattern: cap.mechanics.resultLinkPattern,
        maxItems: options.maxItems ?? 100,
        allowedHosts: Array.from(new Set([hostnameOf(origin), pageHost].filter(Boolean))),
      });
    }
    samples[cap.capabilityId] = sample;
  }
  return samples;
}
