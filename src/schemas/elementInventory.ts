import { z } from 'zod';
import { defineArtifact } from './common.js';
import { FormClassification } from './pageInventory.js';

export const ELEMENT_INVENTORY_VERSION = '1.0.0';

export const LocatorStrategy = z.enum(['testid', 'css-id', 'role', 'label', 'placeholder', 'name', 'text', 'alt', 'title', 'css-path']);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const LocatorCandidate = z.object({
  strategy: LocatorStrategy,
  value: z.string().describe('Strategy-specific value: the test id, the CSS selector, "role|name" for role, etc.'),
  unique: z.boolean().describe('Matched exactly one element at inspection time.'),
  matches: z.number().int().nonnegative(),
  score: z.number().describe('Higher is preferred. Semantic and test-id locators outrank CSS paths.'),
});
export type LocatorCandidate = z.infer<typeof LocatorCandidate>;

export const ElementKind = z.enum(['link', 'button', 'textbox', 'searchbox', 'select', 'checkbox', 'radio', 'switch', 'slider', 'tab', 'menuitem', 'combobox', 'summary', 'form', 'table', 'other']);
export type ElementKind = z.infer<typeof ElementKind>;

export const ElementCategory = z.enum(['navigation', 'search', 'filter', 'selection', 'form-submission', 'data-display', 'authentication', 'consequential', 'other']);
export type ElementCategory = z.infer<typeof ElementCategory>;

export const ElementRecord = z.object({
  elementId: z.string(),
  pageUrl: z.string(),
  kind: ElementKind,
  role: z.string().optional(),
  name: z.string().optional().describe('Accessible name approximation.'),
  text: z.string().optional(),
  tag: z.string(),
  attributes: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    href: z.string().optional(),
    testId: z.string().optional(),
    ariaLabel: z.string().optional(),
    placeholder: z.string().optional(),
    ariaExpanded: z.string().optional(),
    ariaHasPopup: z.string().optional(),
    ariaControls: z.string().optional(),
    ariaSelected: z.string().optional(),
    rel: z.string().optional(),
    value: z.string().optional(),
  }),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional().describe('Select options, capped.'),
  visible: z.boolean(),
  inViewport: z.boolean(),
  boundingBox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  region: z.string().optional().describe('Enclosing landmark role, if any.'),
  inDialog: z.boolean(),
  formId: z.string().optional(),
  category: ElementCategory,
  consequential: z.boolean(),
  consequentialReasons: z.array(z.string()),
  locators: z.array(LocatorCandidate).describe('Ranked; the first unique one is the preferred locator.'),
});
export type ElementRecord = z.infer<typeof ElementRecord>;

export const FormInventoryRecord = z.object({
  formId: z.string(),
  pageUrl: z.string(),
  action: z.string(),
  method: z.enum(['get', 'post', 'other']),
  classification: FormClassification,
  sideEffectHint: z.enum(['read', 'write', 'unknown']),
  fieldElementIds: z.array(z.string()),
  submitElementId: z.string().optional(),
  locators: z.array(LocatorCandidate),
  hasSensitiveFields: z.boolean().describe('Password, payment, or personal-identifier fields present.'),
});
export type FormInventoryRecord = z.infer<typeof FormInventoryRecord>;

export const ElementInventoryData = z.object({
  elements: z.array(ElementRecord),
  forms: z.array(FormInventoryRecord),
  stats: z.object({
    pages: z.number().int().nonnegative(),
    elements: z.number().int().nonnegative(),
    withUniqueLocator: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    byCategory: z.record(z.string(), z.number().int().nonnegative()),
    truncatedPages: z.number().int().nonnegative(),
  }),
});
export type ElementInventoryData = z.infer<typeof ElementInventoryData>;

export const ElementInventory = defineArtifact('ElementInventory', ElementInventoryData);
export type ElementInventory = z.infer<typeof ElementInventory>;
