import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserRuntime } from '../src/browser/runtime.js';
import { BrowseSession, BrowseRefusal, browseToolDefinitions, type WorkflowProposal } from '../src/model/browse.js';
import { generateProgramTool } from '../src/tools/generateProgram.js';
import { executeTool } from '../src/tools/interpreter.js';
import { ScopePolicy } from '../src/net/scope.js';
import type { WebsiteModelData } from '../src/schemas/websiteModel.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let runtime: BrowserRuntime;
let scope: ScopePolicy;
beforeAll(async () => {
  site = await startFixtureSite();
  scope = new ScopePolicy({ origin: site.baseUrl, allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true, respectRobots: true, userAgent: 'test' });
  runtime = new BrowserRuntime({ scope, allowPrivate: true, userAgent: 'WebMorphTest/1' });
  await runtime.launch();
});
afterAll(async () => {
  await runtime.close();
  await site.close();
});

const options = () => ({ scope, pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500, maxElementsPerPage: 400, maxLinksPerPage: 200, maxActions: 20, maxOpens: 5 });
const model = { site: { origin: '' } } as unknown as WebsiteModelData;

describe('the model drives the browser (D27)', () => {
  it('opens the app, acts within guardrails, sees the requests each action caused, finds the result items, and turns the session into a validated tool', async () => {
    const session = new BrowseSession(runtime, options());
    try {
      const s0 = await session.open(`${site.baseUrl}/app`);
      expect(s0.title).toBe('Trip finder');
      expect(s0.requests).toContainEqual(expect.objectContaining({ method: 'POST', url: expect.stringContaining('/api/session'), status: 200, allowedAs: 'app-request', bodyKeys: ['username', 'password', 'clientKey'] }));
      const catBtn = s0.elements.find((e) => e.name?.startsWith('Category'))!;
      expect(catBtn).toBeDefined();
      const s1 = await session.act({ action: 'click', elementId: catBtn.elementId });
      const option = s1.elements.find((e) => (e.name ?? e.text) === 'Cheap')!;
      expect(option, 'the dropdown option should be visible after the click').toBeDefined();
      const s2 = await session.act({ action: 'click', elementId: option.elementId });
      expect(s2.elements.find((e) => e.name?.startsWith('Category'))?.name).toBe('Category: Cheap');
      const find = s2.elements.find((e) => e.name === 'Find trips')!;
      const s3 = await session.act({ action: 'click', elementId: find.elementId });
      expect(s3.requests).toContainEqual(expect.objectContaining({ method: 'POST', url: expect.stringContaining('/api/search'), status: 200, allowedAs: 'app-request', bodyKeys: ['category'] }));
      expect(s3.headings).toContain('3 trips');
      expect(s3.actionIndex).toBe(3);
      expect(s3.actionsLeft).toBe(17);

      // Guardrails: consequential controls, out-of-scope opens and unknown ids are refused before anything happens.
      const buy = s3.elements.find((e) => e.name === 'Buy now')!;
      expect(buy.consequential).toBe(true);
      await expect(session.act({ action: 'click', elementId: buy.elementId })).rejects.toThrow(BrowseRefusal);
      await expect(session.open('https://external.example/')).rejects.toThrow(/out of scope/);
      await expect(session.act({ action: 'click', elementId: 'el-nope' })).rejects.toThrow(/unknown elementId/);
      await expect(session.act({ action: 'press', elementId: find.elementId, key: 'F12' })).rejects.toThrow(/key must be/);
      expect(site.buys).toEqual([]);

      // What the page shows as results, with selectors the model can use.
      const read = await session.read({ mode: 'items', selector: null });
      expect(read.items).toMatchObject({ item: expect.stringContaining('article.trip'), count: 3 });
      expect(read.items!.fields.map((f) => f.selector)).toEqual(expect.arrayContaining(['h3.name', 'span.price', 'a.more']));
      expect(read.items!.fields.find((f) => f.selector === 'a.more')?.href).toContain('/products/');
      const text = await session.read({ mode: 'text', selector: '#results h2' });
      expect(text.text?.[0]?.text).toBe('3 trips');

      // The session becomes a program: the option click is parameterized by the input.
      const proposal: WorkflowProposal = {
        kind: 'search',
        name: 'find_trips',
        title: 'Find trips',
        description: 'Pick a category and list the trips with price and duration.',
        entity: 'trip',
        inputs: [{ name: 'category', type: 'string', required: true, description: 'Cheap or Premium', example: 'Cheap', actionIndex: 2, mode: 'locator' }],
        extract: { kind: 'item-list', item: read.items!.item, fields: [{ name: 'name', selector: 'h3.name', attr: null }, { name: 'price', selector: 'span.price', attr: null }, { name: 'url', selector: 'a.more', attr: 'href' }], hrefPattern: null, maxItems: 50 },
        resultUrlPattern: null,
        expectedOutcome: 'Trips of the category with name, price and link.',
        confidence: 0.9,
        evidence: [],
      };
      const cap = session.buildWorkflowCapability(proposal, site.baseUrl);
      expect(cap).toMatchObject({ name: 'find_trips', source: 'model', sideEffectClass: 'read', authRequirement: 'none', entity: 'trip' });
      const program = cap.mechanics.program as Array<Record<string, unknown>>;
      expect(program.map((s) => s['op'])).toEqual(['navigate', 'wait', 'click', 'wait', 'click', 'wait', 'click', 'wait', 'extract']);
      expect((program[4]!['locator'] as { value: string }).value).toBe('option|{{category}}');
      expect(cap.evidence).toContainEqual(expect.objectContaining({ artifactType: 'PageModel', refId: `${site.baseUrl}/app` }));

      // Bindings that do not match the session are refused with a reason.
      expect(() => session.buildWorkflowCapability({ ...proposal, inputs: [{ ...proposal.inputs[0]!, example: 'Expensive' }] }, site.baseUrl)).toThrow(/contains "Expensive"/);
      expect(() => session.buildWorkflowCapability({ ...proposal, inputs: [{ ...proposal.inputs[0]!, actionIndex: 9 }] }, site.baseUrl)).toThrow(/not a recorded action/);

      // Generated and replayed in a fresh context with a different input: the tool generalizes.
      const tool = generateProgramTool(cap, { ...model, site: { ...model.site, origin: site.baseUrl } }, { pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 })!;
      expect(tool).toMatchObject({ transport: 'browser', name: 'find_trips' });
      expect(tool.inputSchema).toMatchObject({ required: ['category'] });
      const premium = await executeTool(runtime, tool, { category: 'Premium' }, { scope, pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 });
      expect(premium.ok, premium.errorMessage).toBe(true);
      const out = premium.output as { results: Array<{ name: string; price: string; url: string }>; count: number };
      expect(out.count).toBe(3);
      expect(out.results.map((r) => r.name)).toEqual(['Product 4', 'Product 5', 'Product 6']);
      expect(out.results[0]!.url).toBe(`${site.baseUrl}/products/4`);
    } finally {
      await session.close();
    }
    expect(site.buys).toEqual([]);
  }, 120_000);

  it('declares strict browsing tools', () => {
    const tools = browseToolDefinitions();
    expect(tools.map((t) => t.name)).toEqual(['browse_open', 'browse_act', 'browse_read', 'propose_workflow']);
    for (const t of tools) expect(t.strict && t.input_schema.additionalProperties === false).toBe(true);
  });
});
