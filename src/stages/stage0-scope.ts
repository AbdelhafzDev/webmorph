import type { StageDefinition } from '../core/job.js';
import { InvalidTargetError } from '../core/errors.js';
import { assertPublicHost } from '../net/ssrf.js';
import { ScopePolicy } from '../net/scope.js';
import { normalizeUrl, originOf, hostnameOf, FETCH_NORMALIZE } from '../net/url.js';
import { SiteManifest, SITE_MANIFEST_VERSION, type SiteManifestData } from '../schemas/siteManifest.js';
import { credentialRefOf } from '../schemas/siteConfig.js';
import { ANALYSIS_VERSION } from '../version.js';
import { DEFAULT_BUDGET, DEFAULT_PROHIBITED_ACTIONS, DEFAULT_USER_AGENT, makeEnvelope, type DiscoveryInput } from './shared.js';

/**
 * Stage 0: validate the target, fix the scope and budgets, and reject unsafe
 * targets before anything is fetched.
 */
export const stage0Scope: StageDefinition<DiscoveryInput> = {
  id: 'stage0-scope',
  produces: ['SiteManifest'],
  requires: [],
  optional: false,

  async run(ctx) {
    const input = ctx.input;
    const raw = input.startUrl.trim();
    if (!/^https?:\/\//i.test(raw)) {
      throw new InvalidTargetError(`Start URL must use http or https: ${raw}`);
    }
    const normalized = normalizeUrl(raw, undefined, FETCH_NORMALIZE);
    if (!normalized) throw new InvalidTargetError(`Start URL is not a valid absolute URL: ${raw}`);

    const allowPrivate = input.allowPrivate ?? false;
    const host = hostnameOf(normalized);
    if (/[^a-z0-9.\-:\[\]]/i.test(host)) throw new InvalidTargetError(`Hostname contains unexpected characters: ${host}`);

    const addresses = await assertPublicHost(host, { allowPrivate, resolver: input.resolver });

    // Credentials the operator configured for this site are recorded by reference only; the values stay in the site config.
    const siteConfig = await ctx.store.readSiteConfig(ctx.siteId);
    const apiCredentials = siteConfig.apiCredentials.map(credentialRefOf);
    if (apiCredentials.length) ctx.logger.info(`scope: ${apiCredentials.length} operator-configured API credential(s): ${apiCredentials.map((c) => `${c.name} (${c.header} to ${c.host})`).join(', ')}`);

    const budget = { ...DEFAULT_BUDGET, ...stripUndefined(input.budget ?? {}) };
    const data: SiteManifestData = {
      analysisVersion: ANALYSIS_VERSION,
      startUrl: raw,
      normalizedStartUrl: normalized,
      scope: {
        origin: originOf(normalized),
        allowedHosts: ScopePolicy.allowedHostsFor(normalized, input.allowedHosts ?? []),
        allowPrivateNetwork: allowPrivate,
        respectRobots: input.respectRobots ?? true,
        userAgent: input.userAgent ?? DEFAULT_USER_AGENT,
      },
      budget,
      prohibited: {
        hosts: [],
        pathPatterns: input.prohibitedPathPatterns ?? [],
        actions: DEFAULT_PROHIBITED_ACTIONS,
      },
      auth: { mode: 'none', apiCredentials },
      resolvedAddresses: addresses.map((a) => a.address),
    };

    const artifact = {
      ...makeEnvelope({
        type: 'SiteManifest',
        schemaVersion: SITE_MANIFEST_VERSION,
        siteId: ctx.siteId,
        jobId: ctx.jobId,
        stage: 'stage0-scope',
        sources: [],
        now: ctx.now,
      }),
      data,
    };
    return [SiteManifest.parse(artifact)];
  },
};

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
