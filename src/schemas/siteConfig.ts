import { z } from 'zod';

export const SITE_CONFIG_VERSION = '1.0.0';

/** Name a tool's http step refers to. Letters, digits and a few separators; `@` lets default names read as header@host. */
export const CredentialName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,99}$/);

/** Everything about a configured credential except its value. Safe to record in artifacts. */
export const ApiCredentialRef = z.object({
  name: CredentialName,
  host: z.string().describe('Hostname, or host:port, the credential may be sent to. Exact match, case-insensitive.'),
  header: z.string().describe('Lowercase request header that carries the credential, e.g. authorization.'),
});
export type ApiCredentialRef = z.infer<typeof ApiCredentialRef>;

/** An operator-configured credential for a keyed public API. Lives only in the mutable site config. */
export const ApiCredential = ApiCredentialRef.extend({
  value: z.string().min(1).describe('Header value sent verbatim at run time. Never copied into artifacts, evidence or logs.'),
});
export type ApiCredential = z.infer<typeof ApiCredential>;

/**
 * Mutable per-site configuration, kept beside the registry and outside the
 * immutable job folders. This is the only place a credential value is stored.
 */
export const SiteConfig = z.object({
  schemaVersion: z.string(),
  siteId: z.string(),
  updatedAt: z.iso.datetime(),
  apiCredentials: z.array(ApiCredential).default([]),
});
export type SiteConfig = z.infer<typeof SiteConfig>;

export function emptySiteConfig(siteId: string, now: () => Date = () => new Date()): SiteConfig {
  return { schemaVersion: SITE_CONFIG_VERSION, siteId, updatedAt: now().toISOString(), apiCredentials: [] };
}

/** Lowercase, without a trailing dot; a URL is reduced to its host (with port when one is given). */
export function normalizeCredentialHost(host: string): string {
  let h = host.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) {
    try {
      h = new URL(h).host;
    } catch {
      // keep as given
    }
  }
  return h.toLowerCase().replace(/\.$/, '');
}

export function credentialRefOf(credential: ApiCredentialRef): ApiCredentialRef {
  return { name: credential.name, host: credential.host, header: credential.header };
}

/** The name a credential gets when the operator gives none: header@host. */
export function defaultCredentialName(host: string, header: string): string {
  return `${header.toLowerCase()}@${normalizeCredentialHost(host)}`;
}

/** Does this credential cover the given target host and header? Host matches the hostname or host:port exactly. */
export function credentialCovers(ref: ApiCredentialRef, target: URL, header: string): boolean {
  if (ref.header.toLowerCase() !== header.toLowerCase()) return false;
  const host = normalizeCredentialHost(ref.host);
  return host === target.hostname.toLowerCase() || host === target.host.toLowerCase();
}

/** The configured credential that covers a target host and header, if any. */
export function findCredentialFor<T extends ApiCredentialRef>(refs: readonly T[], target: URL, header: string): T | undefined {
  return refs.find((ref) => credentialCovers(ref, target, header));
}

/**
 * Parse the CLI form `[name@]host:header=value`. The host may carry a port
 * (`127.0.0.1:8080:authorization=...`): the last colon before `=` separates
 * host from header. Throws on malformed input with a message that never echoes the value.
 */
export function parseApiCredentialSpec(spec: string): ApiCredential {
  const eq = spec.indexOf('=');
  if (eq <= 0) throw new Error('expected [name@]host:header=value');
  let lhs = spec.slice(0, eq).trim();
  const value = spec.slice(eq + 1);
  if (!value) throw new Error('credential value is empty');
  let name: string | undefined;
  const at = lhs.indexOf('@');
  if (at > 0) {
    name = lhs.slice(0, at).trim();
    lhs = lhs.slice(at + 1).trim();
  }
  const colon = lhs.lastIndexOf(':');
  if (colon <= 0 || colon === lhs.length - 1) throw new Error('expected [name@]host:header=value');
  const host = normalizeCredentialHost(lhs.slice(0, colon));
  const header = lhs.slice(colon + 1).trim().toLowerCase();
  if (!host || !/^[a-z0-9-]+$/.test(header)) throw new Error('expected [name@]host:header=value with a plain header name');
  return ApiCredential.parse({ name: name ?? defaultCredentialName(host, header), host, header, value });
}

/** Parse the JSON file form: {"apiCredentials":[{"name"?,"host","header","value"}]} or a bare array. */
export function parseApiCredentialsFile(text: string): ApiCredential[] {
  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as { apiCredentials?: unknown }).apiCredentials : undefined;
  if (!Array.isArray(list)) throw new Error('expected {"apiCredentials":[...]} or an array');
  return list.map((entry) => {
    const e = entry as Record<string, unknown>;
    const host = typeof e['host'] === 'string' ? normalizeCredentialHost(e['host']) : '';
    const header = typeof e['header'] === 'string' ? e['header'].toLowerCase() : '';
    return ApiCredential.parse({ name: typeof e['name'] === 'string' && e['name'] ? e['name'] : defaultCredentialName(host, header), host, header, value: e['value'] });
  });
}
