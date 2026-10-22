import { describe, expect, it } from 'vitest';
import { buildLocators, preferredLocator } from '../src/browser/locators.js';
import { classifyElement } from '../src/browser/classify.js';
import { chooseQuery } from '../src/browser/probes.js';
import type { ElementRecord } from '../src/schemas/elementInventory.js';
import type { InspectedPage } from '../src/schemas/pageModel.js';
import type { RawElement } from '../src/browser/collect.js';

function raw(partial: Partial<RawElement> & { tag: string }): RawElement {
  return {
    index: 0,
    attrs: {},
    visible: true,
    inViewport: true,
    inDialog: false,
    inDetails: false,
    isSubmit: false,
    stableId: false,
    cssPath: 'body > main > div:nth-of-type(2) > a',
    counts: {},
    ...partial,
  };
}

describe('buildLocators', () => {
  it('prefers test ids, then stable ids, then role and name, and keeps CSS paths last', () => {
    const el = raw({ tag: 'input', role: 'searchbox', name: 'Search products', attrs: { testIdAttr: 'data-testid', testId: 'search-input', id: 'q-input', name: 'q', placeholder: 'Search products', type: 'search' }, stableId: true, counts: { testid: 1, id: 1, roleName: 1, placeholder: 1, name: 1 } });
    const locs = buildLocators(el);
    expect(locs.map((l) => l.strategy)).toEqual(['testid', 'css-id', 'role', 'placeholder', 'name', 'css-path']);
    expect(locs[0]).toMatchObject({ value: '[data-testid="search-input"]', unique: true, score: 100 });
    expect(preferredLocator(locs)?.strategy).toBe('testid');
  });
  it('demotes non-unique candidates below unique ones', () => {
    const el = raw({ tag: 'a', role: 'link', name: 'Read more', text: 'Read more', counts: { roleName: 5, text: 5 } });
    const locs = buildLocators(el);
    expect(locs[0]?.strategy).toBe('css-path');
    expect(locs.find((l) => l.strategy === 'role')).toMatchObject({ unique: false, matches: 5, score: 21 });
  });
  it('uses getByLabel when the accessible name came from a label', () => {
    const el = raw({ tag: 'select', role: 'combobox', name: 'Sort by', attrs: { id: 'sort', name: 'sort' }, stableId: true, counts: { id: 1, roleName: 1, name: 1 } });
    expect(buildLocators(el).map((l) => l.strategy)).toContain('label');
  });
  it('treats generated ids as unstable', () => {
    const el = raw({ tag: 'button', role: 'button', name: 'Menu', attrs: { id: ':r1a:' }, stableId: false, counts: { roleName: 1 } });
    expect(buildLocators(el).map((l) => l.strategy)).not.toContain('css-id');
  });
});

describe('classifyElement', () => {
  it('marks purchase, auth and POST submit controls as consequential or authentication', () => {
    expect(classifyElement(raw({ tag: 'button', role: 'button', name: 'Add to cart' }))).toMatchObject({ category: 'consequential', consequential: true });
    expect(classifyElement(raw({ tag: 'button', role: 'button', name: 'Sign in' }))).toMatchObject({ category: 'authentication', consequential: true });
    expect(classifyElement(raw({ tag: 'a', role: 'link', name: 'Account', attrs: { href: 'https://a.test/account' } }))).toMatchObject({ category: 'authentication' });
    const submit = classifyElement(raw({ tag: 'button', role: 'button', name: 'Apply', isSubmit: true, formIndex: 0 }), { classification: 'unknown', method: 'post', hasPassword: false });
    expect(submit.consequential).toBe(true);
    expect(submit.consequentialReasons).toContain('submits a POST form');
  });
  it('classifies search, filter, navigation and selection controls', () => {
    expect(classifyElement(raw({ tag: 'input', role: 'searchbox', name: 'Search', attrs: { type: 'search', name: 'q' } })).category).toBe('search');
    expect(classifyElement(raw({ tag: 'select', role: 'combobox', name: 'Sort by', attrs: { name: 'sort' } })).category).toBe('filter');
    expect(classifyElement(raw({ tag: 'select', role: 'combobox', name: 'Country', attrs: { name: 'country' } })).category).toBe('selection');
    expect(classifyElement(raw({ tag: 'a', role: 'link', name: 'Products', region: 'navigation', attrs: { href: 'https://a.test/products' } })).category).toBe('navigation');
    expect(classifyElement(raw({ tag: 'a', role: 'link', name: 'Next', text: 'Next', attrs: { href: 'https://a.test/p?page=2', rel: 'next' } })).category).toBe('navigation');
    expect(classifyElement(raw({ tag: 'button', role: 'tab', name: 'Specs' })).kind).toBe('tab');
    expect(classifyElement(raw({ tag: 'button', role: 'button', name: 'Apply', isSubmit: true }), { classification: 'filter', method: 'get', hasPassword: false })).toMatchObject({ category: 'form-submission', consequential: false });
  });
  it('flags consent acceptance inside dialogs', () => {
    const accept = classifyElement(raw({ tag: 'button', role: 'button', name: 'Accept all cookies', inDialog: true }));
    expect(accept.consequential).toBe(true);
  });
});

describe('css-path uniqueness', () => {
  it('is measured, not assumed', () => {
    const el = raw({ tag: 'button', role: 'button', cssPath: 'body > div > div > button', counts: { cssPath: 2 } });
    const locs = buildLocators(el);
    expect(locs.find((l) => l.strategy === 'css-path')).toMatchObject({ unique: false, matches: 2 });
    expect(preferredLocator(locs)?.strategy).toBe('css-path');
  });
});

describe('chooseQuery', () => {
  const link = (name: string, href: string): ElementRecord => ({ elementId: name, pageUrl: 'https://a.test/', kind: 'link', tag: 'a', name, attributes: { href }, visible: true, inViewport: true, inDialog: false, category: 'navigation', consequential: false, consequentialReasons: [], locators: [] });
  const page = { rendered: { headings: [{ level: 1, text: 'Welcome to the marketplace' }] }, title: 'Home' } as unknown as InspectedPage;
  it('ignores UI words and picks the most frequent content word', () => {
    const els = ['icon', 'icon', 'icon', 'cars for sale', 'cars for rent', 'used cars', 'phones for sale'].map((n, i) => link(n, `https://a.test/${i}`));
    expect(chooseQuery(page, els)).toBe('cars');
  });
  it('falls back to a heading word', () => {
    expect(chooseQuery(page, [link('icon', 'https://a.test/1'), link('icon', 'https://a.test/2')])).toBe('marketplace');
  });
});
