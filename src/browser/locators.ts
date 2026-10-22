import type { Locator, Page } from 'playwright';
import type { LocatorCandidate, LocatorStrategy } from '../schemas/elementInventory.js';
import type { RawElement, RawForm } from './collect.js';

const BASE_SCORE: Record<LocatorStrategy, number> = {
  testid: 100,
  'css-id': 90,
  role: 85,
  label: 80,
  placeholder: 70,
  name: 65,
  text: 60,
  alt: 55,
  title: 50,
  'css-path': 30,
};

const esc = (v: string): string => v.replace(/["\\]/g, '\\$&');

function candidate(strategy: LocatorStrategy, value: string, matches: number): LocatorCandidate {
  const unique = matches === 1;
  const score = unique ? BASE_SCORE[strategy] : matches === 0 ? 0 : Math.round(BASE_SCORE[strategy] * 0.25);
  return { strategy, value, unique, matches, score };
}

/** Rank locator candidates for an element. Semantic and test-id locators first, CSS paths last. */
export function buildLocators(raw: RawElement): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  const a = raw.attrs;

  if (a.testIdAttr && a.testId) out.push(candidate('testid', `[${a.testIdAttr}="${esc(a.testId)}"]`, raw.counts.testid ?? 1));
  if (a.id && raw.stableId) out.push(candidate('css-id', `#${cssEscapeIdent(a.id)}`, raw.counts.id ?? 1));
  // Playwright does not expose <summary> under the button role, so skip role locators for it.
  if (raw.role && raw.name && raw.name.length <= 80 && raw.tag !== 'summary') out.push(candidate('role', `${raw.role}|${raw.name}`, raw.counts.roleName ?? 1));
  const isField = raw.tag === 'input' || raw.tag === 'select' || raw.tag === 'textarea';
  if (isField && raw.name && !a.ariaLabel && raw.name !== a.placeholder && raw.name !== a.title) {
    // Name came from a <label>; getByLabel is the natural locator.
    out.push(candidate('label', raw.name, raw.counts.roleName ?? 1));
  }
  if (a.placeholder) out.push(candidate('placeholder', a.placeholder, raw.counts.placeholder ?? 1));
  if (isField && a.name) out.push(candidate('name', `${raw.tag}[name="${esc(a.name)}"]`, raw.counts.name ?? 1));
  if (raw.text && raw.text.length <= 80 && (raw.tag === 'a' || raw.tag === 'button' || raw.tag === 'summary' || raw.role === 'button' || raw.role === 'link' || raw.role === 'tab')) {
    out.push(candidate('text', raw.text, raw.counts.text ?? 1));
  }
  if (a.title) out.push(candidate('title', a.title, raw.counts.title ?? 1));
  if (raw.cssPath) out.push(candidate('css-path', raw.cssPath, raw.counts.cssPath ?? 1));

  return out.sort((x, y) => y.score - x.score || x.strategy.localeCompare(y.strategy));
}

export function buildFormLocators(raw: RawForm): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  if (raw.id && raw.stableId) out.push(candidate('css-id', `#${cssEscapeIdent(raw.id)}`, 1));
  if (raw.name) out.push(candidate('name', `form[name="${esc(raw.name)}"]`, 1));
  if (raw.cssPath) out.push(candidate('css-path', raw.cssPath, 1));
  return out.sort((x, y) => y.score - x.score);
}

/** Turn a stored candidate back into a live Playwright locator. */
export function toLocator(page: Page, c: LocatorCandidate): Locator {
  switch (c.strategy) {
    case 'testid':
    case 'css-id':
    case 'name':
    case 'css-path':
      return page.locator(c.value);
    case 'role': {
      const i = c.value.indexOf('|');
      const role = (i >= 0 ? c.value.slice(0, i) : c.value) as Parameters<Page['getByRole']>[0];
      const name = i >= 0 ? c.value.slice(i + 1) : undefined;
      return name ? page.getByRole(role, { name, exact: true }) : page.getByRole(role);
    }
    case 'label':
      return page.getByLabel(c.value, { exact: true });
    case 'placeholder':
      return page.getByPlaceholder(c.value, { exact: true });
    case 'text':
      return page.getByText(c.value, { exact: true });
    case 'alt':
      return page.getByAltText(c.value, { exact: true });
    case 'title':
      return page.getByTitle(c.value, { exact: true });
  }
}

/** The best unique candidate, else the best available. */
export function preferredLocator(candidates: LocatorCandidate[]): LocatorCandidate | undefined {
  return candidates.find((c) => c.unique) ?? candidates[0];
}

function cssEscapeIdent(id: string): string {
  // Minimal CSS identifier escaping for ids we already judged stable.
  return id.replace(/([^a-zA-Z0-9_-])/g, '\\$1').replace(/^(\d)/, '\\3$1 ');
}
