import type { ElementCategory, ElementKind } from '../schemas/elementInventory.js';
import type { FormClassification } from '../schemas/pageInventory.js';
import { SEARCH_FIELD_NAMES } from '../html/forms.js';
import type { RawElement } from './collect.js';

/** Words that mark an action as consequential. Matched against name, text, value, id and href. */
export const CONSEQUENTIAL_PATTERN =
  /\b(buy|purchase|checkout|check out|pay|payment|place order|order now|add to (cart|bag|basket)|delete|remove|destroy|unsubscribe|cancel|confirm|submit|send|post|publish|share|tweet|sign ?up|register|create (an |your )?account|log ?in|sign ?in|log ?out|sign ?out|subscribe|donate|book now|reserve|apply now|upload|transfer|withdraw|deposit|vote|like|follow|report|block|accept all|agree|save changes|update profile|change password|verify)\b/i;

export const AUTH_PATTERN = /\b(log ?in|sign ?in|log ?out|sign ?out|register|sign ?up|password|create (an |your )?account|forgot|my account|account)\b/i;
const AUTH_HREF = /(login|signin|sign-in|logout|signout|sign-out|register|signup|sign-up|auth|account|password)/i;
const FILTER_NAME = /^(sort|sort_by|order|orderby|filter|filters|category|cat|price|price_min|price_max|min_price|max_price|color|colour|size|brand|rating|min|max|page_size|per_page|view|type|status)$/i;
const NEXT_PATTERN = /^(next|next page|older|more|›|»|>|→|load more|show more)$/i;
const CONSENT_PATTERN = /\b(cookie|cookies|consent|gdpr|privacy settings|preferences)\b/i;

export interface ClassifiedElement {
  kind: ElementKind;
  category: ElementCategory;
  consequential: boolean;
  consequentialReasons: string[];
}

export interface FormContext {
  classification: FormClassification;
  method: 'get' | 'post' | 'other';
  hasPassword: boolean;
}

export function elementKind(raw: RawElement): ElementKind {
  const role = raw.role;
  const tag = raw.tag;
  const type = raw.attrs.type;
  if (tag === 'summary') return 'summary';
  if (tag === 'form') return 'form';
  if (tag === 'table' || role === 'table') return 'table';
  if (role === 'tab') return 'tab';
  if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') return 'menuitem';
  if (role === 'switch') return 'switch';
  if (role === 'slider') return 'slider';
  if (role === 'searchbox') return 'searchbox';
  if (role === 'checkbox') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (tag === 'select') return 'select';
  if (role === 'combobox' || role === 'listbox') return 'combobox';
  if (role === 'link' || tag === 'a') return 'link';
  if (role === 'button' || tag === 'button' || (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset' || type === 'image'))) return 'button';
  if (role === 'textbox' || role === 'spinbutton' || tag === 'textarea' || tag === 'input') return 'textbox';
  return 'other';
}

export function classifyElement(raw: RawElement, form?: FormContext): ClassifiedElement {
  const kind = elementKind(raw);
  const a = raw.attrs;
  const label = `${raw.name ?? ''} ${raw.text ?? ''} ${a.value ?? ''} ${a.ariaLabel ?? ''}`.trim();
  const idish = `${a.id ?? ''} ${a.name ?? ''}`;
  const href = a.href ?? '';
  const reasons: string[] = [];

  const actsOnClick = kind === 'button' || kind === 'link' || kind === 'menuitem' || kind === 'summary';
  if (actsOnClick && CONSEQUENTIAL_PATTERN.test(label)) reasons.push(`label matches "${label.match(CONSEQUENTIAL_PATTERN)?.[0]}"`);
  if (kind === 'button' && raw.isSubmit && form && form.method === 'post') reasons.push('submits a POST form');
  if (kind === 'button' && raw.isSubmit && form?.hasPassword) reasons.push('submits a credential form');
  if (kind === 'link' && /\/(logout|signout|sign-out|delete|remove|unsubscribe|checkout|cart\/add)/i.test(href)) reasons.push('href is an action path');
  if (raw.inDialog && CONSENT_PATTERN.test(label) && /accept|agree|allow/i.test(label)) reasons.push('accepts a consent dialog');

  const isAuth =
    a.type === 'password' ||
    form?.classification === 'login' ||
    form?.classification === 'signup' ||
    (actsOnClick && AUTH_PATTERN.test(label)) ||
    (kind === 'link' && AUTH_HREF.test(new URL(href, 'http://x').pathname));

  let category: ElementCategory;
  if (isAuth) category = 'authentication';
  else if (reasons.length > 0) category = 'consequential';
  else if (kind === 'searchbox' || SEARCH_FIELD_NAMES.has((a.name ?? '').toLowerCase()) || form?.classification === 'search' || raw.region === 'search' || (kind === 'button' && /\bsearch\b/i.test(label) && !raw.inDialog)) category = 'search';
  else if ((kind === 'select' || kind === 'combobox' || kind === 'checkbox' || kind === 'radio' || kind === 'slider' || kind === 'switch') && (FILTER_NAME.test(a.name ?? '') || form?.classification === 'filter' || /filter|sort|refine/i.test(idish + ' ' + label))) category = 'filter';
  else if (kind === 'tab' || kind === 'menuitem' || (kind === 'link' && (raw.region === 'navigation' || raw.region === 'banner' || raw.region === 'contentinfo' || /\bnext\b|\bprev/i.test(a.rel ?? '') || NEXT_PATTERN.test(raw.text ?? '')))) category = 'navigation';
  else if (kind === 'select' || kind === 'combobox' || kind === 'checkbox' || kind === 'radio' || kind === 'switch' || kind === 'slider') category = 'selection';
  else if (kind === 'button' && raw.isSubmit) category = 'form-submission';
  else if (kind === 'table') category = 'data-display';
  else if (kind === 'link') category = 'navigation';
  else category = 'other';

  return { kind, category, consequential: reasons.length > 0, consequentialReasons: reasons };
}

export function isConsentLike(text: string): boolean {
  return CONSENT_PATTERN.test(text);
}

export function isNextLink(raw: RawElement): boolean {
  return raw.tag === 'a' && (/\bnext\b/i.test(raw.attrs.rel ?? '') || NEXT_PATTERN.test(raw.text ?? '') || NEXT_PATTERN.test(raw.name ?? ''));
}
