/**
 * In-page instrumentation for recording. Serialized and installed as an init
 * script, so it must be self-contained. It reports semantic descriptors of the
 * elements the user acts on; values of sensitive fields never leave the page.
 */

export interface InPageElement {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  attrs: { id?: string; name?: string; type?: string; href?: string; testIdAttr?: string; testId?: string; ariaLabel?: string; placeholder?: string; value?: string };
  cssPath: string;
  stableId: boolean;
  counts: { testid?: number; id?: number; name?: number; placeholder?: number; ariaLabel?: number; text?: number; roleName?: number; cssPath?: number };
  formAction?: string;
  formMethod?: string;
  isSubmit: boolean;
  inDialog: boolean;
  /** For links: the pathname pattern and how many links on the page share it. */
  resultContext?: { pathPattern: string; siblingCount: number; inList: boolean };
}

export type InPageEvent =
  | { type: 'click'; target: InPageElement }
  | { type: 'input' | 'select'; target: InPageElement; fieldType: string; valueKind: 'text' | 'number' | 'option' | 'checked' | 'unchecked' | 'file'; valueLength: number; value?: string; optionLabel?: string; sensitive: boolean }
  | { type: 'submit'; target: InPageElement }
  | { type: 'key'; key: string; target: InPageElement };

export const BINDING_NAME = '__webmorphRecordEvent';

export function describeElement(el: Element): InPageElement {
  const doc = document;
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  const escAttr = (v: string): string => v.replace(/["\\]/g, '\\$&');
  const countSel = (sel: string): number => {
    try {
      return doc.querySelectorAll(sel).length;
    } catch {
      return 0;
    }
  };
  const stableId = (id: string): boolean => !(/\d{3,}/.test(id) || /[0-9a-f]{6,}/i.test(id) || id.includes(':') || /^(ember|react|ui-id|mui|radix|headlessui|chakra|__|yui_|gwt-)/i.test(id) || id.length > 48);
  const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-automation-id'];
  const implicitRole = (e: Element): string | undefined => {
    const tag = e.tagName.toLowerCase();
    const type = (e.getAttribute('type') ?? 'text').toLowerCase();
    if (tag === 'a') return e.hasAttribute('href') ? 'link' : undefined;
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return undefined;
      return 'textbox';
    }
    return undefined;
  };
  const labelText = (e: Element): string => {
    let t = '';
    if (e.id) t = Array.from(doc.querySelectorAll(`label[for="${escAttr(e.id)}"]`)).map((l) => clean(l.textContent)).join(' ');
    if (!t) {
      const wrap = e.closest('label');
      if (wrap) t = clean(wrap.textContent);
    }
    return t;
  };
  const accName = (e: Element): string => {
    const labelledBy = e.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => clean(doc.getElementById(id)?.textContent)).filter(Boolean).join(' ');
      if (t) return t.slice(0, 160);
    }
    const ariaLabel = clean(e.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel.slice(0, 160);
    const tag = e.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const lt = labelText(e);
      if (lt) return lt.slice(0, 160);
      const type = (e.getAttribute('type') ?? '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const v = clean(e.getAttribute('value'));
        if (v) return v.slice(0, 160);
      }
      const ph = clean(e.getAttribute('placeholder'));
      if (ph) return ph.slice(0, 160);
      return clean(e.getAttribute('title')).slice(0, 160);
    }
    const text = clean((e as HTMLElement).innerText || e.textContent);
    if (text) return text.slice(0, 160);
    const imgAlt = Array.from(e.querySelectorAll('img[alt]')).map((i) => clean(i.getAttribute('alt'))).filter(Boolean).join(' ');
    if (imgAlt) return imgAlt.slice(0, 160);
    return clean(e.getAttribute('title')).slice(0, 160);
  };
  const cssPath = (e: Element): string => {
    const parts: string[] = [];
    let n: Element | null = e;
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

  const pathPatternOf = (href: string): string | undefined => {
    try {
      const u = new URL(href, location.href);
      if (u.origin !== location.origin) return undefined;
      const segs = u.pathname.split('/').filter(Boolean).map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f-]{36}$/i.test(s) || (/\d/.test(s) && /[-_]/.test(s) && s.length >= 6) ? '{x}' : s.toLowerCase()));
      return '/' + segs.join('/');
    } catch {
      return undefined;
    }
  };
  let resultContext: InPageElement['resultContext'];
  if (el.tagName.toLowerCase() === 'a' && el.hasAttribute('href')) {
    const pattern = pathPatternOf((el as HTMLAnchorElement).href);
    if (pattern && pattern.includes('{x}')) {
      const siblingCount = Array.from(doc.querySelectorAll('a[href]')).filter((a) => pathPatternOf((a as HTMLAnchorElement).href) === pattern).length;
      resultContext = { pathPattern: pattern, siblingCount, inList: Boolean(el.closest('li, [role="listitem"], tr, article, [class*="card"], [class*="result"], [class*="item"]')) };
    }
  }

  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' || tag === 'button' ? (el.getAttribute('type') ?? (tag === 'button' ? 'submit' : 'text')).toLowerCase() : undefined;
  const role = el.getAttribute('role') ?? implicitRole(el);
  const name = accName(el);
  const text = clean((el as HTMLElement).innerText || '').slice(0, 160) || undefined;
  const testIdAttr = TESTID_ATTRS.find((a) => el.hasAttribute(a));
  const testId = testIdAttr ? el.getAttribute(testIdAttr) ?? undefined : undefined;
  const id = el.id || undefined;
  const nameAttr = el.getAttribute('name') ?? undefined;
  const placeholder = el.getAttribute('placeholder') ?? undefined;
  const ariaLabel = el.getAttribute('aria-label') ?? undefined;
  const path = cssPath(el);
  const form = el.closest('form');
  const counts: InPageElement['counts'] = { cssPath: countSel(path) };
  if (testIdAttr && testId) counts.testid = countSel(`[${testIdAttr}="${escAttr(testId)}"]`);
  if (id) counts.id = countSel(`#${CSS.escape(id)}`);
  if (nameAttr) counts.name = countSel(`${tag}[name="${escAttr(nameAttr)}"]`);
  if (placeholder) counts.placeholder = countSel(`[placeholder="${escAttr(placeholder)}"]`);
  if (ariaLabel) counts.ariaLabel = countSel(`[aria-label="${escAttr(ariaLabel)}"]`);
  if (text) counts.text = Array.from(doc.querySelectorAll('a, button, summary, [role="button"], [role="link"], [role="tab"]')).filter((x) => clean((x as HTMLElement).innerText) === text).length || 1;
  if (role && name) counts.roleName = Array.from(doc.querySelectorAll('a[href], button, input, select, textarea, summary, [role]')).filter((x) => (x.getAttribute('role') ?? implicitRole(x)) === role && accName(x) === name).length || 1;

  return {
    tag,
    role: role ?? undefined,
    name: name || undefined,
    text,
    attrs: { id, name: nameAttr, type, href: tag === 'a' ? (el as HTMLAnchorElement).href : undefined, testIdAttr, testId, ariaLabel, placeholder, value: tag === 'input' && (type === 'submit' || type === 'button') ? el.getAttribute('value') ?? undefined : undefined },
    cssPath: path,
    stableId: Boolean(id && stableId(id)),
    counts,
    formAction: form ? new URL(form.getAttribute('action') ?? '', location.href).toString() : undefined,
    formMethod: form ? (form.getAttribute('method') ?? 'get').toLowerCase() : undefined,
    isSubmit: (tag === 'button' && (type === 'submit' || !el.hasAttribute('type'))) || (tag === 'input' && (type === 'submit' || type === 'image')),
    inDialog: Boolean(el.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')),
    ...(resultContext ? { resultContext } : {}),
  };
}

/** Build the init script: listeners in the capture phase that report through the exposed binding. */
export function buildInstrumentScript(): string {
  const describeSource = describeElement.toString();
  return `(() => {
  if (window.__webmorphRecorderInstalled) return;
  window.__webmorphRecorderInstalled = true;
  const __name = (t) => t;
  const describe = (${describeSource});
  const SENSITIVE_TYPES = ['password', 'email', 'tel', 'file', 'hidden'];
  const SENSITIVE_NAME = /(passw|pwd|card|cc-?num|cvc|cvv|ssn|social|passport|iban|account.?(no|num)|routing|tax.?id|secret|token|otp|pin\\b|e-?mail|phone|birth|dob)/i;
  const send = (payload) => { try { window.${BINDING_NAME}(payload); } catch (e) {} };
  const INTERACTIVE = 'a, button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"], [onclick]';
  const isField = (el) => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
  // Typing is tracked per field and flushed as one input event before the next action, so the
  // recorded order is fill, then press or click, as a person experiences it.
  const pending = new Map();
  const fieldEvent = (el) => {
    const fieldType = el instanceof HTMLSelectElement ? 'select' : el instanceof HTMLTextAreaElement ? 'textarea' : (el.type || 'text').toLowerCase();
    const sensitive = SENSITIVE_TYPES.includes(fieldType) || SENSITIVE_NAME.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('autocomplete') || '') + ' ' + (el.placeholder || ''));
    let valueKind = 'text';
    if (el instanceof HTMLSelectElement) valueKind = 'option';
    else if (el instanceof HTMLInputElement && (fieldType === 'checkbox' || fieldType === 'radio')) valueKind = el.checked ? 'checked' : 'unchecked';
    else if (fieldType === 'number' || fieldType === 'range') valueKind = 'number';
    else if (fieldType === 'file') valueKind = 'file';
    const value = el instanceof HTMLInputElement && fieldType === 'file' ? '' : String(el.value || '');
    return { type: el instanceof HTMLSelectElement ? 'select' : 'input', target: describe(el), fieldType, valueKind, valueLength: value.length, value: sensitive ? undefined : value.slice(0, 500), optionLabel: el instanceof HTMLSelectElement ? (el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : undefined) : undefined, sensitive };
  };
  const flush = (only) => {
    for (const el of Array.from(pending.keys())) {
      if (only && el !== only) continue;
      pending.delete(el);
      send(fieldEvent(el));
    }
  };
  document.addEventListener('input', (e) => { if (isField(e.target)) pending.set(e.target, true); }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!isField(el)) return;
    if (pending.has(el)) flush(el);
    else if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file'))) send(fieldEvent(el));
  }, true);
  document.addEventListener('focusout', (e) => { if (isField(e.target) && pending.has(e.target)) flush(e.target); }, true);
  document.addEventListener('click', (e) => {
    flush();
    const t = e.target instanceof Element ? (e.target.closest(INTERACTIVE) || e.target) : null;
    if (!t) return;
    send({ type: 'click', target: describe(t) });
  }, true);
  document.addEventListener('submit', (e) => {
    flush();
    if (e.target instanceof Element) send({ type: 'submit', target: describe(e.target) });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof Element && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      flush(e.target);
      send({ type: 'key', key: 'Enter', target: describe(e.target) });
    }
  }, true);
  window.addEventListener('pagehide', () => flush(), true);
})();`;
}
