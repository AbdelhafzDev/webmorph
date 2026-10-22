/**
 * In-page collector. `collectPageSnapshot` is serialized and evaluated inside
 * the browser, so it must be self-contained: no imports, no references to
 * module scope. Types here describe what comes back.
 */

export interface CollectOptions {
  maxElements: number;
  maxLinks: number;
}

export interface RawCounts {
  testid?: number;
  id?: number;
  name?: number;
  placeholder?: number;
  ariaLabel?: number;
  text?: number;
  roleName?: number;
  title?: number;
  cssPath?: number;
}

export interface RawElement {
  index: number;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  attrs: {
    id?: string;
    name?: string;
    type?: string;
    href?: string;
    testIdAttr?: string;
    testId?: string;
    ariaLabel?: string;
    placeholder?: string;
    ariaExpanded?: string;
    ariaHasPopup?: string;
    ariaControls?: string;
    ariaSelected?: string;
    rel?: string;
    value?: string;
    title?: string;
  };
  visible: boolean;
  inViewport: boolean;
  box?: { x: number; y: number; width: number; height: number };
  region?: string;
  inDialog: boolean;
  inDetails: boolean;
  formIndex?: number;
  isSubmit: boolean;
  stableId: boolean;
  cssPath: string;
  counts: RawCounts;
  options?: Array<{ value: string; label: string }>;
}

export interface RawForm {
  index: number;
  id?: string;
  name?: string;
  action: string;
  method: string;
  attrs: string;
  cssPath: string;
  stableId: boolean;
  fieldIndexes: number[];
  submitIndex?: number;
  hasPassword: boolean;
}

export interface RawRegion {
  role: string;
  name?: string;
  interactiveCount: number;
  linkCount: number;
}

export interface RawDialog {
  role: string;
  name?: string;
  modal: boolean;
  textSample: string;
  buttonNames: string[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  textLength: number;
  linkCount: number;
  interactiveCount: number;
  dialogCount: number;
  headings: Array<{ level: number; text: string }>;
  elements: RawElement[];
  forms: RawForm[];
  regions: RawRegion[];
  dialogs: RawDialog[];
  truncated: boolean;
  stateHash: string;
}

export interface QuickState {
  url: string;
  title: string;
  textLength: number;
  interactiveCount: number;
  linkCount: number;
  dialogCount: number;
  stateHash: string;
  links: string[];
}

export function collectPageSnapshot(opts: CollectOptions): PageSnapshot {
  const doc = document;
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="searchbox"], [role="textbox"], [role="option"], [role="slider"], [contenteditable="true"], [contenteditable=""]';
  const LANDMARKS = ['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'search', 'form', 'region', 'dialog', 'alertdialog'];
  const TAG_LANDMARK: Record<string, string> = { nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form', dialog: 'dialog' };
  const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-automation-id'];
  const escAttr = (v: string): string => v.replace(/["\\]/g, '\\$&');
  const countSel = (sel: string): number => {
    try {
      return doc.querySelectorAll(sel).length;
    } catch {
      return 0;
    }
  };
  const stableId = (id: string): boolean =>
    !(/\d{3,}/.test(id) || /[0-9a-f]{6,}/i.test(id) || id.includes(':') || /^(ember|react|ui-id|mui|radix|headlessui|chakra|__|yui_|gwt-)/i.test(id) || id.length > 48);

  const implicitRole = (el: Element): string | undefined => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    switch (tag) {
      case 'a':
        return el.hasAttribute('href') ? 'link' : undefined;
      case 'button':
      case 'summary':
        return 'button';
      case 'select':
        return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
      case 'textarea':
        return 'textbox';
      case 'input':
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (type === 'hidden') return undefined;
        return 'textbox';
      case 'table':
        return 'table';
      case 'img':
        return 'img';
      case 'dialog':
        return 'dialog';
      default:
        return (el as HTMLElement).isContentEditable ? 'textbox' : undefined;
    }
  };

  const labelText = (el: Element): string => {
    let t = '';
    if (el.id) t = Array.from(doc.querySelectorAll(`label[for="${escAttr(el.id)}"]`)).map((l) => clean(l.textContent)).join(' ');
    if (!t) {
      const wrap = el.closest('label');
      if (wrap) t = clean(wrap.textContent);
    }
    return t;
  };

  const accName = (el: Element): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => clean(doc.getElementById(id)?.textContent)).filter(Boolean).join(' ');
      if (t) return t.slice(0, 160);
    }
    const ariaLabel = clean(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel.slice(0, 160);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const lt = labelText(el);
      if (lt) return lt.slice(0, 160);
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const v = clean(el.getAttribute('value'));
        if (v) return v.slice(0, 160);
        if (type === 'submit') return 'Submit';
      }
      if (type === 'image') {
        const a = clean(el.getAttribute('alt'));
        if (a) return a.slice(0, 160);
      }
      const ph = clean(el.getAttribute('placeholder'));
      if (ph) return ph.slice(0, 160);
      return clean(el.getAttribute('title')).slice(0, 160);
    }
    if (tag === 'img') return clean(el.getAttribute('alt')).slice(0, 160);
    const text = clean((el as HTMLElement).innerText || el.textContent);
    if (text) return text.slice(0, 160);
    const imgAlt = Array.from(el.querySelectorAll('img[alt]')).map((i) => clean(i.getAttribute('alt'))).filter(Boolean).join(' ');
    if (imgAlt) return imgAlt.slice(0, 160);
    return clean(el.getAttribute('title')).slice(0, 160);
  };

  const isVisible = (el: Element): boolean => {
    if (!(el as HTMLElement).getClientRects().length) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  };

  const landmarkOf = (el: Element): string | undefined => {
    let n: Element | null = el.parentElement;
    while (n) {
      const role = n.getAttribute('role') ?? TAG_LANDMARK[n.tagName.toLowerCase()];
      if (role && LANDMARKS.includes(role)) return role;
      n = n.parentElement;
    }
    return undefined;
  };

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let n: Element | null = el;
    let depth = 0;
    while (n && n !== doc.body && n !== doc.documentElement && depth < 24) {
      if (n.id && stableId(n.id)) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      let sel = n.tagName.toLowerCase();
      const parent: Element | null = n.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === n!.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(sel);
      n = parent;
      depth += 1;
    }
    if (n === doc.body) parts.unshift('body');
    return parts.join(' > ');
  };

  const all = Array.from(doc.querySelectorAll(INTERACTIVE)).filter((el) => {
    const tag = el.tagName.toLowerCase();
    return !(tag === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'hidden');
  });

  // Uniqueness maps over the whole interactive set.
  const textCounts = new Map<string, number>();
  const roleNameCounts = new Map<string, number>();
  const roleOf = (el: Element): string | undefined => el.getAttribute('role') ?? implicitRole(el);
  const nameCache = new Map<Element, string>();
  for (const el of all) {
    const name = accName(el);
    nameCache.set(el, name);
    const role = roleOf(el);
    const text = clean((el as HTMLElement).innerText || '');
    if (text) textCounts.set(text, (textCounts.get(text) ?? 0) + 1);
    if (role && name) roleNameCounts.set(`${role}|${name}`, (roleNameCounts.get(`${role}|${name}`) ?? 0) + 1);
  }

  const nonLinks = all.filter((el) => el.tagName !== 'A');
  const seenHref = new Set<string>();
  const links: Element[] = [];
  for (const a of all) {
    if (a.tagName !== 'A') continue;
    const href = (a as HTMLAnchorElement).href;
    if (seenHref.has(href)) continue;
    seenHref.add(href);
    links.push(a);
    if (links.length >= opts.maxLinks) break;
  }
  let selected = [...nonLinks, ...links];
  const truncated = selected.length > opts.maxElements;
  selected = selected.slice(0, opts.maxElements);

  const formEls = Array.from(doc.querySelectorAll('form'));
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const elements: RawElement[] = selected.map((el, index) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' || tag === 'button' ? (el.getAttribute('type') ?? (tag === 'button' ? 'submit' : 'text')).toLowerCase() : undefined;
    const name = nameCache.get(el) ?? '';
    const text = clean((el as HTMLElement).innerText || '').slice(0, 160) || undefined;
    const role = roleOf(el);
    const testIdAttr = TESTID_ATTRS.find((a) => el.hasAttribute(a));
    const testId = testIdAttr ? el.getAttribute(testIdAttr) ?? undefined : undefined;
    const id = el.id || undefined;
    const nameAttr = el.getAttribute('name') ?? undefined;
    const placeholder = el.getAttribute('placeholder') ?? undefined;
    const ariaLabel = el.getAttribute('aria-label') ?? undefined;
    const title = el.getAttribute('title') ?? undefined;
    const form = el.closest('form');
    const formIndex = form ? formEls.indexOf(form) : -1;
    const isSubmit = (tag === 'button' && (type === 'submit' || !el.hasAttribute('type'))) || (tag === 'input' && (type === 'submit' || type === 'image'));
    const rect = (el as HTMLElement).getBoundingClientRect();
    const visible = isVisible(el);
    const counts: RawCounts = {};
    if (testIdAttr && testId) counts.testid = countSel(`[${testIdAttr}="${escAttr(testId)}"]`);
    if (id) counts.id = countSel(`#${CSS.escape(id)}`);
    if (nameAttr) counts.name = countSel(`${tag}[name="${escAttr(nameAttr)}"]`);
    if (placeholder) counts.placeholder = countSel(`[placeholder="${escAttr(placeholder)}"]`);
    if (ariaLabel) counts.ariaLabel = countSel(`[aria-label="${escAttr(ariaLabel)}"]`);
    if (title) counts.title = countSel(`[title="${escAttr(title)}"]`);
    if (text) counts.text = textCounts.get(text) ?? 1;
    if (role && name) counts.roleName = roleNameCounts.get(`${role}|${name}`) ?? 1;
    const path = cssPath(el);
    counts.cssPath = countSel(path);

    return {
      index,
      tag,
      role,
      name: name || undefined,
      text,
      attrs: {
        id,
        name: nameAttr,
        type,
        href: tag === 'a' ? (el as HTMLAnchorElement).href : undefined,
        testIdAttr,
        testId,
        ariaLabel,
        placeholder,
        ariaExpanded: el.getAttribute('aria-expanded') ?? undefined,
        ariaHasPopup: el.getAttribute('aria-haspopup') ?? undefined,
        ariaControls: el.getAttribute('aria-controls') ?? undefined,
        ariaSelected: el.getAttribute('aria-selected') ?? undefined,
        rel: el.getAttribute('rel') ?? undefined,
        value: tag === 'input' && (type === 'submit' || type === 'button') ? el.getAttribute('value') ?? undefined : undefined,
        title,
      },
      visible,
      inViewport: visible && rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw,
      box: visible ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : undefined,
      region: landmarkOf(el),
      inDialog: Boolean(el.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')),
      inDetails: Boolean(el.closest('details')),
      formIndex: formIndex >= 0 ? formIndex : undefined,
      isSubmit,
      stableId: Boolean(id && stableId(id)),
      cssPath: path,
      counts,
      options: tag === 'select' ? Array.from((el as HTMLSelectElement).options).slice(0, 50).map((o) => ({ value: o.value, label: clean(o.textContent) })) : undefined,
    };
  });

  const forms: RawForm[] = formEls.map((form, index) => {
    const actionAttr = form.getAttribute('action');
    let action = location.href;
    try {
      action = new URL(actionAttr ?? '', location.href).toString();
    } catch {
      // keep current URL
    }
    const fieldIndexes = elements.filter((e) => e.formIndex === index && (e.tag === 'input' || e.tag === 'select' || e.tag === 'textarea') && !e.isSubmit).map((e) => e.index);
    const submit = elements.find((e) => e.formIndex === index && e.isSubmit);
    const id = form.id || undefined;
    return {
      index,
      id,
      name: form.getAttribute('name') ?? undefined,
      action,
      method: (form.getAttribute('method') ?? 'get').toLowerCase(),
      attrs: `${form.id} ${form.className} ${form.getAttribute('role') ?? ''} ${form.getAttribute('aria-label') ?? ''} ${action}`.toLowerCase(),
      cssPath: cssPath(form),
      stableId: Boolean(id && stableId(id)),
      fieldIndexes,
      submitIndex: submit?.index,
      hasPassword: Boolean(form.querySelector('input[type="password"]')),
    };
  });

  const regions: RawRegion[] = Array.from(doc.querySelectorAll('nav, main, header, footer, aside, form, dialog, [role="navigation"], [role="main"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"], [role="region"], [role="dialog"], [role="alertdialog"]'))
    .filter((el) => isVisible(el))
    .slice(0, 40)
    .map((el) => ({
      role: el.getAttribute('role') ?? TAG_LANDMARK[el.tagName.toLowerCase()] ?? 'region',
      name: accNameForRegion(el) || undefined,
      interactiveCount: el.querySelectorAll(INTERACTIVE).length,
      linkCount: el.querySelectorAll('a[href]').length,
    }));

  function accNameForRegion(el: Element): string {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => clean(doc.getElementById(id)?.textContent)).filter(Boolean).join(' ');
      if (t) return t.slice(0, 120);
    }
    return clean(el.getAttribute('aria-label')).slice(0, 120);
  }

  const dialogEls = Array.from(doc.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')).filter((el) => isVisible(el));
  const dialogs: RawDialog[] = dialogEls.slice(0, 10).map((el) => ({
    role: el.getAttribute('role') ?? 'dialog',
    name: accNameForRegion(el) || undefined,
    modal: el.getAttribute('aria-modal') === 'true' || el.tagName.toLowerCase() === 'dialog',
    textSample: clean((el as HTMLElement).innerText).slice(0, 300),
    buttonNames: Array.from(el.querySelectorAll('button, [role="button"], input[type="submit"], a[href]'))
      .map((b) => accName(b))
      .filter(Boolean)
      .slice(0, 10),
  }));

  const headings = Array.from(doc.querySelectorAll('h1, h2, h3'))
    .filter((h) => isVisible(h))
    .slice(0, 40)
    .map((h) => ({ level: Number(h.tagName.slice(1)), text: clean(h.textContent).slice(0, 200) }))
    .filter((h) => h.text);

  const text = clean(doc.body ? (doc.body as HTMLElement).innerText : '');
  const visibleInteractive = all.filter((el) => isVisible(el)).length;
  const linkCount = doc.querySelectorAll('a[href]').length;
  let h = 5381;
  const hashInput = `${location.href}|${visibleInteractive}|${text.slice(0, 60000)}`;
  for (let i = 0; i < hashInput.length; i += 1) h = ((h << 5) + h + hashInput.charCodeAt(i)) | 0;

  return {
    url: location.href,
    title: doc.title,
    textLength: text.length,
    linkCount,
    interactiveCount: visibleInteractive,
    dialogCount: dialogEls.length,
    headings,
    elements,
    forms,
    regions,
    dialogs,
    truncated,
    stateHash: (h >>> 0).toString(16).padStart(8, '0'),
  };
}

/** Cheap state capture used around interaction probes. Also evaluated in-page. */
export function collectQuickState(): QuickState {
  const doc = document;
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"]';
  const isVisible = (el: Element): boolean => {
    if (!(el as HTMLElement).getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[aria-hidden="true"]');
  };
  const text = clean(doc.body ? (doc.body as HTMLElement).innerText : '');
  const interactiveCount = Array.from(doc.querySelectorAll(INTERACTIVE)).filter(isVisible).length;
  const dialogCount = Array.from(doc.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')).filter(isVisible).length;
  let h = 5381;
  const hashInput = `${location.href}|${interactiveCount}|${text.slice(0, 60000)}`;
  for (let i = 0; i < hashInput.length; i += 1) h = ((h << 5) + h + hashInput.charCodeAt(i)) | 0;
  const links: string[] = [];
  const seenLinks = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = (a as HTMLAnchorElement).href;
    if (!href || seenLinks.has(href) || !/^https?:/.test(href)) continue;
    seenLinks.add(href);
    links.push(href);
    if (links.length >= 100) break;
  }
  return {
    url: location.href,
    title: doc.title,
    textLength: text.length,
    interactiveCount,
    linkCount: doc.querySelectorAll('a[href]').length,
    dialogCount,
    stateHash: (h >>> 0).toString(16).padStart(8, '0'),
    links,
  };
}
