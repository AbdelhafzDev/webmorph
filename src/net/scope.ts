import type { ScopePolicyData } from '../schemas/siteManifest.js';
import { hostnameOf, wwwCounterpart } from './url.js';

/** Decides whether a URL may be fetched. Exact-hostname matching only. */
export class ScopePolicy {
  readonly allowedHosts: ReadonlySet<string>;
  private readonly prohibitedHosts: ReadonlySet<string>;
  private readonly prohibitedPaths: RegExp[];

  constructor(
    readonly data: ScopePolicyData,
    prohibited: { hosts?: string[]; pathPatterns?: string[] } = {},
  ) {
    this.allowedHosts = new Set(data.allowedHosts.map((h) => h.toLowerCase()));
    this.prohibitedHosts = new Set((prohibited.hosts ?? []).map((h) => h.toLowerCase()));
    this.prohibitedPaths = (prohibited.pathPatterns ?? []).map((p) => new RegExp(p, 'i'));
  }

  static allowedHostsFor(startUrl: string, extraHosts: string[] = []): string[] {
    const host = hostnameOf(startUrl);
    const hosts = new Set<string>([host, ...extraHosts.map((h) => h.toLowerCase())]);
    const alt = wwwCounterpart(host);
    if (alt) hosts.add(alt);
    return Array.from(hosts);
  }

  /** A copy that also allows the given hosts (same-site API hosts for tool execution). */
  withHosts(extra: string[]): ScopePolicy {
    return new ScopePolicy({ ...this.data, allowedHosts: Array.from(new Set([...this.data.allowedHosts, ...extra.map((h) => h.toLowerCase())])) }, { hosts: Array.from(this.prohibitedHosts), pathPatterns: this.prohibitedPaths.map((r) => r.source) });
  }

  isHostAllowed(hostname: string): boolean {
    const h = hostname.toLowerCase();
    return this.allowedHosts.has(h) && !this.prohibitedHosts.has(h);
  }

  isInScope(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return this.isHostAllowed(parsed.hostname);
  }

  isProhibitedPath(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return true;
    }
    const target = parsed.pathname + parsed.search;
    return this.prohibitedPaths.some((re) => re.test(target));
  }
}
