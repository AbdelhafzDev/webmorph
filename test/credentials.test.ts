import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { discover, ToolExecutor, ToolRegistry, createMcpServer, executeTool, scopeFromManifest, SafeHttpClient, ScopePolicy } from '../src/index.js';
import { ApiCandidates, NetworkEvidence, SiteManifest, ToolDefinition, ValidationReport, WebsiteModel } from '../src/schemas/index.js';
import { parseApiCredentialSpec, parseApiCredentialsFile, credentialCovers, emptySiteConfig, type ApiCredential } from '../src/schemas/siteConfig.js';
import type { ToolSpec } from '../src/schemas/toolDefinition.js';
import { KEYED_API_KEY, startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;
beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-credentials-'));
});
afterAll(async () => {
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

const KEY_SECRET = KEYED_API_KEY.replace(/^Bearer /, '');
const budget = { maxPages: 4, maxDepth: 0, minDelayMs: 0, maxPagesToInspect: 1, maxProbesPerPage: 3, maxProbesTotal: 3, settleTimeoutMs: 1000, pageLoadTimeoutMs: 15_000, validationRuns: 1 };
const credential = (): ApiCredential => ({ name: 'keyed', host: '127.0.0.1', header: 'authorization', value: KEYED_API_KEY });

/** Every file under a directory, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

const isKeyedHttpTool = (t: ToolSpec) => t.program.some((s) => s.op === 'http' && s.url.includes('/api/keyed/'));
/** Calls that reached the keyed endpoint without the key so far (the redirect test below makes one on purpose). */
const unauthorized = () => site.keyedCalls.filter((c) => c === 'unauthorized').length;

describe('credential specs', () => {
  it('parses [name@]host:header=value, defaulting the name to header@host and keeping ports and URLs', () => {
    expect(parseApiCredentialSpec('search-api.example.com:authorization=Bearer pk_live_1')).toEqual({ name: 'authorization@search-api.example.com', host: 'search-api.example.com', header: 'authorization', value: 'Bearer pk_live_1' });
    expect(parseApiCredentialSpec('search@https://Search-API.example.com/v1:X-Api-Key=k=v')).toEqual({ name: 'search', host: 'search-api.example.com', header: 'x-api-key', value: 'k=v' });
    expect(parseApiCredentialSpec('127.0.0.1:8080:authorization=Bearer x')).toMatchObject({ host: '127.0.0.1:8080', header: 'authorization' });
    expect(() => parseApiCredentialSpec('no-header=value')).toThrow(/host:header=value/);
    expect(() => parseApiCredentialSpec('host:authorization=')).toThrow(/empty/);
    expect(parseApiCredentialsFile('{"apiCredentials":[{"host":"api.example.com","header":"Authorization","value":"Bearer y"}]}')).toEqual([{ name: 'authorization@api.example.com', host: 'api.example.com', header: 'authorization', value: 'Bearer y' }]);
    const c = { name: 'c', host: 'api.example.com', header: 'authorization' };
    expect(credentialCovers(c, new URL('https://api.example.com:8443/x'), 'Authorization')).toBe(true);
    expect(credentialCovers(c, new URL('https://www.example.com/x'), 'authorization')).toBe(false);
    expect(credentialCovers({ ...c, host: 'api.example.com:8443' }, new URL('https://api.example.com/x'), 'authorization')).toBe(false);
  });
});

describe('SafeHttpClient extra headers', () => {
  it('sends a configured header to the requested origin and drops it across a redirect to another host', async () => {
    const resolver = async (host: string) => (host === 'fixture.test' || host === '127.0.0.1' ? [{ address: '127.0.0.1', family: 4 }] : []);
    const scope = new ScopePolicy({ origin: site.baseUrl, allowedHosts: ['127.0.0.1', 'fixture.test'], allowPrivateNetwork: true, respectRobots: true, userAgent: 'test' });
    const client = new SafeHttpClient({ scope, allowPrivate: true, userAgent: 'WebMorphTest/1', requestTimeoutMs: 5000, maxResponseBytes: 200_000, maxRedirects: 3, maxRetries: 0, minDelayMs: 0, maxConcurrency: 2, maxRequests: 10, resolver, sleep: async () => {} });
    try {
      const direct = await client.fetch(`${site.baseUrl}/api/keyed/products?q=product`, { accept: 'application/json', headers: { Authorization: KEYED_API_KEY } });
      expect(direct.ok && direct.status).toBe(200);
      const hopped = await client.fetch(`${site.baseUrl}/keyed-hop`, { accept: 'application/json', headers: { authorization: KEYED_API_KEY } });
      expect(hopped.ok && hopped.status).toBe(401);
      expect(hopped.ok && hopped.finalUrl).toContain('fixture.test');
      expect(site.keyedCalls.slice(-2)).toEqual(['authorized', 'unauthorized']);
    } finally {
      await client.close();
    }
  });
});

describe('operator-configured credentials for keyed public APIs (D23)', () => {
  it('without configuration the keyed request stays credentialed and no _api tool is generated', async () => {
    const unauthorizedAtStart = unauthorized();
    const result = await discover({ startUrl: `${site.baseUrl}/keyed`, outDir, allowPrivate: true, model: { enabled: false }, budget, sleep: async () => {} });
    const { store, siteId, jobId } = result;
    expect(result.job.status).toBe('completed');
    const manifest = await store.readArtifact(siteId, jobId, 'SiteManifest', SiteManifest);
    expect(manifest.data.auth.apiCredentials).toEqual([]);

    const network = (await store.readArtifact(siteId, jobId, 'NetworkEvidence', NetworkEvidence)).data;
    const keyed = network.records.find((r) => r.url.includes('/api/keyed/products'))!;
    expect(keyed).toMatchObject({ method: 'GET', status: 200, credentialed: true, credentialHeaders: ['authorization'] });
    expect(JSON.stringify(network)).not.toContain(KEY_SECRET);

    const candidates = (await store.readArtifact(siteId, jobId, 'ApiCandidates', ApiCandidates)).data.candidates;
    const candidate = candidates.find((c) => c.pathPattern === '/api/keyed/products')!;
    expect(candidate).toMatchObject({ credentialed: true, sideEffectHint: 'read' });
    expect(candidate.configuredCredential).toBeUndefined();
    expect(candidate.note).toContain('never promoted');

    const model = (await store.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel)).data;
    const cap = model.capabilities.find((c) => c.mechanics.api?.urlTemplate.includes('/api/keyed/'))!;
    expect(cap, 'the keyed search capability should still be linked to its observed API').toBeDefined();
    expect(cap.mechanics.api).toMatchObject({ credentialed: true });
    expect(cap.mechanics.api?.credentialRef).toBeUndefined();

    const tools = (await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data.tools;
    expect(tools.some(isKeyedHttpTool)).toBe(false);
    expect(tools.some((t) => t.name === cap.name)).toBe(true); // the browser tool for the same search exists
    expect(unauthorized()).toBe(unauthorizedAtStart); // nothing replayed the endpoint without the key
  }, 120_000);

  it('with the credential configured the tool is generated with a credentialRef, validates, and the key never reaches an artifact or evidence file', async () => {
    const unauthorizedAtStart = unauthorized();
    const result = await discover({ startUrl: `${site.baseUrl}/keyed`, outDir, allowPrivate: true, model: { enabled: false }, budget, sleep: async () => {}, apiCredentials: [credential()] });
    const { store, siteId, jobId } = result;
    expect(result.job.status).toBe('completed');

    // The manifest records the reference only.
    const manifest = await store.readArtifact(siteId, jobId, 'SiteManifest', SiteManifest);
    expect(manifest.data.auth.apiCredentials).toEqual([{ name: 'keyed', host: '127.0.0.1', header: 'authorization' }]);
    // The value lives in the site config, owner-only.
    const config = await store.readSiteConfig(siteId);
    expect(config.apiCredentials).toEqual([credential()]);
    expect((await stat(store.siteConfigPath(siteId))).mode & 0o077).toBe(0);

    const network = (await store.readArtifact(siteId, jobId, 'NetworkEvidence', NetworkEvidence)).data;
    expect(network.records.find((r) => r.url.includes('/api/keyed/products'))).toMatchObject({ credentialed: true, credentialHeaders: ['authorization'] });
    const candidate = (await store.readArtifact(siteId, jobId, 'ApiCandidates', ApiCandidates)).data.candidates.find((c) => c.pathPattern === '/api/keyed/products')!;
    expect(candidate).toMatchObject({ credentialed: false, configuredCredential: 'keyed' });
    expect(candidate.note).toContain('operator-configured credential "keyed"');

    const model = (await store.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel)).data;
    const cap = model.capabilities.find((c) => c.mechanics.api?.urlTemplate.includes('/api/keyed/'))!;
    expect(cap.mechanics.api).toMatchObject({ method: 'GET', queryParams: { q: 'query' }, credentialed: false, credentialRef: 'keyed', authRequired: false });
    expect(model.facts.some((f) => f.statement.includes('/api/keyed/products') && f.statement.includes('"keyed"'))).toBe(true);

    const tools = (await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data.tools;
    const tool = tools.find(isKeyedHttpTool)!;
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ name: cap.name, transport: 'http', sideEffectClass: 'read', authRequirement: 'none' }); // API first: the HTTP route carries the capability's name
    expect(tool.program[0]).toMatchObject({ op: 'http', method: 'GET', credentialRef: 'keyed' });
    expect(tool.preconditions.some((p) => p.kind === 'credential' && p.detail.includes('keyed'))).toBe(true);
    expect(tool.errorCases.some((e) => e.code === 'PERMISSION_DENIED')).toBe(true);
    expect(tool.description).toContain('"keyed"');

    const report = (await store.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport)).data;
    const v = report.tools.find((t) => t.toolId === tool.toolId)!;
    expect(v.verdict, v.failureReasons.join('; ')).toBe('validated');
    expect((v.runs[0]!.output as { data: unknown[]; status: number }).data).toHaveLength(6);
    expect(unauthorized()).toBe(unauthorizedAtStart);
    expect(site.keyedCalls.filter((c) => c === 'authorized').length).toBeGreaterThan(0); // the replay sent the key

    // The key appears nowhere under the job folder: artifacts, evidence, job record, blobs.
    for (const file of await filesUnder(store.jobDir(siteId, jobId))) {
      const text = await readFile(file, 'latin1');
      expect(text.includes(KEY_SECRET), `${file} must not contain the key`).toBe(false);
    }
  }, 120_000);

  it('runs through the executor and MCP with the credential, and fails with PERMISSION_DENIED without it', async () => {
    const unauthorizedAtStart = unauthorized();
    const result = await discover({ startUrl: `${site.baseUrl}/keyed`, outDir, allowPrivate: true, model: { enabled: false }, budget, sleep: async () => {}, apiCredentials: [credential()] });
    const { store, siteId, jobId } = result;
    const manifest = await store.readArtifact(siteId, jobId, 'SiteManifest', SiteManifest);
    const tool = (await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data.tools.find(isKeyedHttpTool)!;
    const registry = new ToolRegistry(store, siteId);
    expect((await registry.publish({ jobId, names: [tool.name] })).published).toEqual([tool.name]);
    expect(await readFile(registry.path, 'utf8')).not.toContain(KEY_SECRET);
    const scope = scopeFromManifest(manifest.data);
    const execOpts = { scope, pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1000 };

    // The interpreter refuses before dialing when the reference is not configured, and when it is configured for another host.
    const missing = await executeTool(null, tool, { query: 'product' }, { ...execOpts, credentials: [] });
    expect(missing).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(missing.errorMessage).toContain('"keyed"');
    expect(missing.steps[0]).toMatchObject({ op: 'http', status: 'failed' });
    const elsewhere = await executeTool(null, tool, { query: 'product' }, { ...execOpts, credentials: [{ ...credential(), host: 'other.example' }] });
    expect(elsewhere).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(unauthorized()).toBe(unauthorizedAtStart);
    // With the credential the direct run succeeds and no run record carries the value.
    const direct = await executeTool(null, tool, { query: 'product 3' }, { ...execOpts, credentials: [credential()] });
    expect(direct.ok, direct.errorMessage).toBe(true);
    expect((direct.output as { data: Array<{ name: string }> }).data).toEqual([{ id: 3, name: 'Product 3', price: 30 }]);
    expect(JSON.stringify(direct)).not.toContain(KEY_SECRET);

    const executor = new ToolExecutor({ store, siteId });
    try {
      const ok = await executor.call(tool.name, { query: 'product 2' });
      expect(ok.ok, ok.errorMessage).toBe(true);
      expect((ok.output as { data: Array<{ name: string }> }).data).toEqual([{ id: 2, name: 'Product 2', price: 20 }]);

      // Through MCP, unchanged.
      const server = createMcpServer({ executor, siteId, origin: site.baseUrl });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '0.0.0' });
      await client.connect(clientTransport);
      try {
        const called = await client.callTool({ name: tool.name, arguments: { query: 'product 4' } });
        expect(called.isError).toBeFalsy();
        expect((called.structuredContent as { data: Array<{ id: number }> }).data).toEqual([{ id: 4, name: 'Product 4', price: 40 }]);

        // Remove the configuration: the published tool now refuses, and the registry does not degrade it.
        await store.writeSiteConfig(emptySiteConfig(siteId));
        const refused = await executor.call(tool.name, { query: 'product' });
        expect(refused).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED', status: 'published' });
        const viaMcp = await client.callTool({ name: tool.name, arguments: { query: 'product' } });
        expect(viaMcp.isError).toBe(true);
        expect(JSON.parse((viaMcp.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'PERMISSION_DENIED' });
        expect((await registry.get(tool.name))!.calls.consecutiveFailures).toBe(0);

        // Restore it: the next call works again without restarting anything.
        await store.upsertApiCredentials(siteId, [credential()]);
        const again = await executor.call(tool.name, { query: 'product 5' });
        expect(again.ok, again.errorMessage).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await executor.close();
    }
    expect(unauthorized()).toBe(unauthorizedAtStart);
  }, 120_000);
});
