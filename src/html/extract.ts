import * as cheerio from 'cheerio';
import type { ScopePolicy } from '../net/scope.js';
import { normalizeUrl, FETCH_NORMALIZE } from '../net/url.js';
import { shortHash } from '../core/ids.js';
import type { FormClassification, FormField, FormRecord, HtmlFacts, LinkRecord } from '../schemas/pageInventory.js';
import { classifyRenderMode } from './renderMode.js';
import { classifyFormFacts, sideEffectHintFor } from './forms.js';

export interface ExtractOptions {
  finalUrl: string;
  scope: ScopePolicy;
  maxLinks: number;
}

const MAX_TEXT_SAMPLE = 600;
const MAX_HEADINGS = 40;
const MAX_FORM_FIELDS = 40;
const MAX_FORMS = 20;
const SKELETON_DEPTH = 4;
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'br']);

type Cheerio = cheerio.CheerioAPI;
type El = ReturnType<Cheerio>[number];

export function extractHtmlFacts(html: string, options: ExtractOptions): HtmlFacts {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').first().attr('href');
  const base = (baseHref && normalizeUrl(baseHref, options.finalUrl, { keepQuery: true })) || options.finalUrl;

  const scripts = collectScripts($, html);
  const jsonLdTypes = collectJsonLdTypes($);
  const forms = collectForms($, base, options.finalUrl).slice(0, MAX_FORMS);
  const { links, internalLinkCount, externalLinkCount, truncated } = collectLinks($, base, options);
  const headings = collectHeadings($);
  const skeletonHash = computeSkeletonHash($);

  const title = clean($('title').first().text()).slice(0, 300) || undefined;
  const lang = $('html').attr('lang')?.trim() || undefined;
  const description = (
    $('meta[name="description"]').attr('content') ??
    $('meta[property="og:description"]').attr('content') ??
    ''
  ).trim().slice(0, 500) || undefined;
  const canonicalRaw = $('link[rel="canonical"]').attr('href');
  const canonical = canonicalRaw ? normalizeUrl(canonicalRaw, base) ?? undefined : undefined;
  const robotsMeta = $('meta[name="robots"]').attr('content')?.trim() || undefined;

  // Visible text: strip non-content nodes first.
  $('script, style, noscript, template, svg').remove();
  const text = clean($('body').text());

  const renderMode = classifyRenderMode({
    htmlLength: html.length,
    textLength: text.length,
    scriptCount: scripts.count,
    internalLinkCount,
    frameworks: scripts.frameworks,
    hasRootMount: scripts.hasRootMount,
  });

  return {
    title,
    lang,
    description,
    canonical,
    robotsMeta,
    headings,
    htmlLength: html.length,
    textLength: text.length,
    textSample: text.slice(0, MAX_TEXT_SAMPLE),
    links,
    internalLinkCount,
    externalLinkCount,
    linksTruncated: truncated,
    forms,
    scripts,
    jsonLdTypes,
    renderMode,
    skeletonHash,
  };
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function collectHeadings($: Cheerio): HtmlFacts['headings'] {
  const out: HtmlFacts['headings'] = [];
  $('h1, h2, h3').each((_, el) => {
    if (out.length >= MAX_HEADINGS) return false;
    const text = clean($(el).text()).slice(0, 200);
    if (!text) return;
    out.push({ level: Number(el.tagName.slice(1)), text });
    return;
  });
  return out;
}

function collectScripts($: Cheerio, html: string): HtmlFacts['scripts'] {
  const scriptEls = $('script');
  const externalCount = scriptEls.filter((_, el) => Boolean($(el).attr('src'))).length;
  const frameworks = new Set<string>();

  const sample = html.length > 400_000 ? html.slice(0, 400_000) : html;
  if (/__NEXT_DATA__|\/_next\/static\//.test(sample) || $('#__next').length) frameworks.add('next');
  if (/__NUXT__|\/_nuxt\//.test(sample) || $('#__nuxt').length) frameworks.add('nuxt');
  if (/ng-version=|ng-app|<app-root/.test(sample)) frameworks.add('angular');
  if (/data-reactroot|react-dom|\breact\b.*\.js/i.test(sample) && !frameworks.has('next')) frameworks.add('react');
  if (/data-v-[0-9a-f]{6,}|vue(\.runtime)?(\.min)?\.js|\bvue\b.*\.js/i.test(sample) && !frameworks.has('nuxt')) frameworks.add('vue');
  if (/data-svelte|svelte-[0-9a-z]{6}/.test(sample)) frameworks.add('svelte');
  if (/<astro-island|astro-static-slot/.test(sample)) frameworks.add('astro');
  if (/__remixContext|data-remix/.test(sample)) frameworks.add('remix');
  if (/___gatsby/.test(sample)) frameworks.add('gatsby');
  if (/ember-cli|data-ember-extension|EmberENV/.test(sample)) frameworks.add('ember');
  if (/wp-content\/|wp-includes\//.test(sample)) frameworks.add('wordpress');
  if (/cdn\.shopify\.com|Shopify\.theme/.test(sample)) frameworks.add('shopify');

  const mountSelectors = ['#root', '#app', '#__next', '#__nuxt', '#___gatsby', '#main-app', '[data-reactroot]', 'app-root', '#q-app'];
  let hasRootMount = false;
  for (const selector of mountSelectors) {
    const el = $(selector).first();
    if (el.length && clean(el.text()).length < 50) {
      hasRootMount = true;
      break;
    }
  }

  return { count: scriptEls.length, externalCount, frameworks: Array.from(frameworks).sort(), hasRootMount };
}

function collectJsonLdTypes($: Cheerio): string[] {
  const types = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      const parsed = JSON.parse(raw) as unknown;
      visitJsonLd(parsed, types, 0);
    } catch {
      // Malformed JSON-LD is common; ignore.
    }
  });
  return Array.from(types).sort().slice(0, 30);
}

function visitJsonLd(node: unknown, types: Set<string>, depth: number): void {
  if (depth > 4 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) visitJsonLd(item, types, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') types.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') types.add(x);
  if (Array.isArray(obj['@graph'])) visitJsonLd(obj['@graph'], types, depth + 1);
  for (const key of ['mainEntity', 'itemListElement', 'item']) {
    if (obj[key] !== undefined) visitJsonLd(obj[key], types, depth + 1);
  }
}

function collectLinks(
  $: Cheerio,
  base: string,
  options: ExtractOptions,
): { links: LinkRecord[]; internalLinkCount: number; externalLinkCount: number; truncated: boolean } {
  const seen = new Set<string>();
  const links: LinkRecord[] = [];
  let internalLinkCount = 0;
  let externalLinkCount = 0;
  let truncated = false;

  $('a[href]').each((_, el) => {
    const hrefRaw = $(el).attr('href') ?? '';
    if (!hrefRaw || /^(javascript:|mailto:|tel:|sms:|data:|#)/i.test(hrefRaw.trim())) return;
    const href = normalizeUrl(hrefRaw, base);
    if (!href || seen.has(href)) return;
    seen.add(href);
    const inScope = options.scope.isInScope(href);
    if (inScope) internalLinkCount += 1;
    else externalLinkCount += 1;
    if (links.length >= options.maxLinks) {
      truncated = true;
      return;
    }
    const rel = $(el).attr('rel')?.trim() || undefined;
    const observed = normalizeUrl(hrefRaw, base, FETCH_NORMALIZE);
    links.push({
      href,
      ...(observed && observed !== href ? { observed } : {}),
      text: clean($(el).text() || $(el).attr('aria-label') || $(el).attr('title') || '').slice(0, 120),
      rel,
      inScope,
      nofollow: /\bnofollow\b/i.test(rel ?? ''),
    });
  });

  return { links, internalLinkCount, externalLinkCount, truncated };
}

function collectForms($: Cheerio, base: string, finalUrl: string): FormRecord[] {
  const forms: FormRecord[] = [];
  $('form').each((_, formEl) => {
    const $form = $(formEl);
    const actionRaw = $form.attr('action');
    const action = (actionRaw ? normalizeUrl(actionRaw, base, { keepQuery: true }) : null) ?? finalUrl;
    const methodRaw = ($form.attr('method') ?? 'get').trim().toLowerCase();
    const method: FormRecord['method'] = methodRaw === 'get' ? 'get' : methodRaw === 'post' ? 'post' : 'other';

    const fields: FormField[] = [];
    let submitText: string | undefined;
    let hasPassword = false;
    $form.find('input, select, textarea, button').each((_, el) => {
      if (fields.length >= MAX_FORM_FIELDS) return false;
      const $el = $(el);
      const tag = el.tagName.toLowerCase();
      const type = (tag === 'input' ? ($el.attr('type') ?? 'text') : tag).toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') {
        if (!submitText && type !== 'reset') {
          submitText = clean($el.attr('value') ?? $el.text() ?? $el.attr('aria-label') ?? '').slice(0, 80) || undefined;
        }
        return;
      }
      if (type === 'password') hasPassword = true;
      const id = $el.attr('id');
      const label =
        (id && clean($(`label[for="${cssEscape(id)}"]`).first().text())) ||
        clean($el.closest('label').text()) ||
        $el.attr('aria-label')?.trim() ||
        undefined;
      const field: FormField = {
        name: $el.attr('name')?.trim() || undefined,
        type,
        label: label ? label.slice(0, 120) : undefined,
        placeholder: $el.attr('placeholder')?.trim() || undefined,
        required: $el.attr('required') !== undefined || $el.attr('aria-required') === 'true',
      };
      if (tag === 'select') field.optionCount = $el.find('option').length;
      fields.push(field);
      return;
    });

    const classification = classifyForm($form, fields, method, action, hasPassword);
    const sideEffectHint = sideEffectHintFor(method, hasPassword);

    forms.push({
      id: $form.attr('id')?.trim() || undefined,
      name: $form.attr('name')?.trim() || undefined,
      action,
      method,
      fields,
      submitText,
      hasPassword,
      classification,
      sideEffectHint,
    });
  });
  return forms;
}

function classifyForm($form: ReturnType<Cheerio>, fields: FormField[], method: FormRecord['method'], action: string, hasPassword: boolean): FormClassification {
  const attrs = `${$form.attr('id') ?? ''} ${$form.attr('class') ?? ''} ${$form.attr('role') ?? ''} ${$form.attr('aria-label') ?? ''} ${action}`.toLowerCase();
  return classifyFormFacts({ fields, method, action, attrs, hasPassword });
}

function cssEscape(id: string): string {
  return id.replace(/["\\]/g, '\\$&');
}

/** Hash of tag structure down to a fixed depth. Class names are ignored because CSS-in-JS makes them unstable. */
function computeSkeletonHash($: Cheerio): string {
  const body = $('body').first();
  const parts: string[] = [];
  const walk = (el: El, depth: number) => {
    if (depth > SKELETON_DEPTH || parts.length > 2000) return;
    const children = $(el).children().toArray();
    for (const child of children) {
      const tag = child.tagName?.toLowerCase();
      if (!tag || SKIP_TAGS.has(tag)) continue;
      parts.push(`${depth}:${tag}`);
      walk(child, depth + 1);
    }
  };
  if (body.length) walk(body[0]!, 0);
  return shortHash(parts.join(','));
}
