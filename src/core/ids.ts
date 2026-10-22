import { createHash, randomUUID } from 'node:crypto';

/** Stable site identifier derived from the normalized origin. Human-readable prefix plus a hash. */
export function siteIdFromOrigin(origin: string): string {
  const host = new URL(origin).hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const hash = createHash('sha256').update(origin).digest('hex').slice(0, 10);
  return `${host}-${hash}`;
}

/** Sortable job identifier: UTC timestamp plus a short random suffix. */
export function newJobId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${ts}-${randomUUID().slice(0, 8)}`;
}

export function newArtifactId(): string {
  return randomUUID();
}

export function shortHash(input: string, length = 12): string {
  return createHash('sha1').update(input).digest('hex').slice(0, length);
}
