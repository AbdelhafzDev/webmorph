import { z } from 'zod';
import { BlobRef } from './common.js';
import { LocatorCandidate } from './elementInventory.js';

export const RECORDING_VERSION = '1.0.0';

/** The element the user acted on, described semantically so it can be re-located later. */
export const ElementDescriptor = z.object({
  tag: z.string(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  attributes: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    href: z.string().optional(),
    testId: z.string().optional(),
    ariaLabel: z.string().optional(),
    placeholder: z.string().optional(),
  }),
  locators: z.array(LocatorCandidate),
  formAction: z.string().optional(),
  formMethod: z.string().optional(),
  isSubmit: z.boolean(),
  inDialog: z.boolean(),
  consequential: z.boolean(),
  resultContext: z.object({ pathPattern: z.string(), siblingCount: z.number().int().nonnegative(), inList: z.boolean() }).optional().describe('For links: pattern shared with sibling links, so a replay can pick a result instead of this exact one.'),
});
export type ElementDescriptor = z.infer<typeof ElementDescriptor>;

export const RecordedInput = z.object({
  fieldType: z.string(),
  valueKind: z.enum(['text', 'number', 'option', 'checked', 'unchecked', 'file']),
  valueLength: z.number().int().nonnegative(),
  redacted: z.boolean().describe('True when the value was withheld: sensitive field, or values not kept.'),
  value: z.string().optional().describe('Present only for non-sensitive fields when the operator kept values.'),
  optionLabel: z.string().optional(),
});

export const RecordedState = z.object({ url: z.string(), title: z.string().optional(), textLength: z.number().int().nonnegative(), stateHash: z.string() });
export type RecordedState = z.infer<typeof RecordedState>;

export const RecordedEventType = z.enum(['navigation', 'click', 'input', 'select', 'submit', 'key']);

export const RecordedEvent = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  pageUrl: z.string(),
  type: RecordedEventType,
  target: ElementDescriptor.optional(),
  input: RecordedInput.optional(),
  key: z.string().optional(),
  navigation: z.object({ from: z.string().optional(), to: z.string(), title: z.string().optional() }).optional(),
  before: RecordedState.optional(),
  after: RecordedState.optional(),
  screenshot: BlobRef.optional(),
  status: z.enum(['ok', 'error']),
  error: z.string().optional(),
});
export type RecordedEvent = z.infer<typeof RecordedEvent>;

export const RecordingSession = z.object({
  schemaVersion: z.string(),
  sessionId: z.string(),
  siteId: z.string(),
  jobId: z.string().describe('Job whose manifest supplied scope and policy.'),
  startUrl: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  status: z.enum(['recording', 'completed', 'aborted']),
  policy: z.object({ keepValues: z.boolean(), screenshots: z.boolean(), allowWrites: z.literal(true), headed: z.boolean() }),
  eventCount: z.number().int().nonnegative(),
  pagesVisited: z.array(z.string()),
  networkRecords: z.number().int().nonnegative(),
  notes: z.array(z.string()),
});
export type RecordingSession = z.infer<typeof RecordingSession>;
