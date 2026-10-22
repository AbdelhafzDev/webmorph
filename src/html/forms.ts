import type { FormClassification, FormField } from '../schemas/pageInventory.js';

export const SEARCH_FIELD_NAMES = new Set(['q', 'query', 's', 'search', 'keyword', 'keywords', 'term', 'k', 'search_query', 'searchterm', 'text']);

const SENSITIVE_TYPES = new Set(['password', 'file', 'email', 'tel']);
const SENSITIVE_NAME = /(passw|pwd|card|cc-?num|cvc|cvv|ssn|social|passport|iban|account.?(no|num)|routing|tax.?id|national.?id|credit|secret|token|otp|pin\b)/i;
const PERSONAL_NAME = /(e-?mail|phone|tel\b|mobile|address|zip|postal|birth|\bdob\b|first.?name|last.?name|full.?name|surname)/i;

export interface FormFacts {
  fields: FormField[];
  method: 'get' | 'post' | 'other';
  action: string;
  /** Lowercased id, class, role, aria-label and action joined together. */
  attrs: string;
  hasPassword: boolean;
}

/** Heuristic form classification shared by the static extractor and the browser inspector. */
export function classifyFormFacts(f: FormFacts): FormClassification {
  const { fields, method, attrs, hasPassword } = f;
  const passwordCount = fields.filter((x) => x.type === 'password').length;
  const emailCount = fields.filter((x) => x.type === 'email' || /email/i.test(x.name ?? '')).length;
  const textLike = fields.filter((x) => ['text', 'search', 'email', 'tel', 'url', 'number', 'textarea'].includes(x.type));
  const chooserLike = fields.filter((x) => ['select', 'checkbox', 'radio', 'range'].includes(x.type));

  if (passwordCount >= 2) return 'signup';
  if (hasPassword) return /sign-?up|register|create/.test(attrs) ? 'signup' : 'login';
  const hasSearchField = fields.some((x) => x.type === 'search' || SEARCH_FIELD_NAMES.has((x.name ?? '').toLowerCase()));
  if (hasSearchField || /\bsearch\b/.test(attrs)) return 'search';
  if (/subscribe|newsletter/.test(attrs) || (emailCount === 1 && fields.length <= 2 && method === 'post')) return 'subscribe';
  if (fields.some((x) => x.type === 'textarea') && (emailCount > 0 || /contact|feedback|support/.test(attrs))) return 'contact';
  if (method === 'get' && chooserLike.length >= 1 && textLike.length === 0) return 'filter';
  if (method === 'get' && /filter|sort|refine/.test(attrs)) return 'filter';
  return 'unknown';
}

export function sideEffectHintFor(method: 'get' | 'post' | 'other', hasPassword: boolean): 'read' | 'write' | 'unknown' {
  if (hasPassword || method === 'post') return 'write';
  return method === 'get' ? 'read' : 'unknown';
}

/** Fields WebMorph never fills: credentials, payment, identifiers, contact details. */
export function formHasSensitiveFields(fields: FormField[]): boolean {
  return fields.some(
    (fd) => SENSITIVE_TYPES.has(fd.type) || SENSITIVE_NAME.test(fd.name ?? '') || PERSONAL_NAME.test(`${fd.name ?? ''} ${fd.label ?? ''} ${fd.placeholder ?? ''}`),
  );
}

export const NEVER_FILL_TYPES = ['password', 'email', 'tel', 'file', 'hidden', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'color'];
