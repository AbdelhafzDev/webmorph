import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserRuntime } from '../src/browser/runtime.js';
import { BrowseSession, BrowseRefusal, bindInUrl, browseToolDefinitions, fixedDatesIn, summarizeRequests, type WorkflowProposal } from '../src/model/browse.js';
import type { NetworkRecord } from '../src/schemas/networkEvidence.js';
import { generateProgramTool } from '../src/tools/generateProgram.js';
import { executeTool, withSchemaDefaults } from '../src/tools/interpreter.js';
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
      // The front end's translation file is counted, not listed.
      expect(s0.requests.some((r) => r.url.includes('/assets/'))).toBe(false);
      expect(s0.otherRequests).toBeGreaterThanOrEqual(1);
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
      expect(program.map((s) => s['op'])).toEqual(['navigate', 'wait', 'click', 'wait', 'click', 'wait', 'click', 'wait', 'wait', 'extract']);
      expect(program[8]).toMatchObject({ op: 'wait', for: 'selector', selector: read.items!.item, optional: true });
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

      // Optional, the input declares its browsed value as the default, and a call without it replays that value.
      const optionalCap = session.buildWorkflowCapability({ ...proposal, name: 'find_trips_default', inputs: [{ ...proposal.inputs[0]!, required: false }] }, site.baseUrl);
      const optionalTool = generateProgramTool(optionalCap, { ...model, site: { ...model.site, origin: site.baseUrl } }, { pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 })!;
      expect(optionalTool.inputSchema).toMatchObject({ required: [], properties: { category: { default: 'Cheap' } } });
      const cheap = await executeTool(runtime, optionalTool, {}, { scope, pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 });
      expect(cheap.ok, cheap.errorMessage).toBe(true);
      expect((cheap.output as { results: Array<{ name: string }> }).results.map((r) => r.name)).toEqual(['Product 1', 'Product 2', 'Product 3']);
    } finally {
      await session.close();
    }
    expect(site.buys).toEqual([]);
  }, 120_000);

  it('starts the program at the page that leads to the bound action and binds several inputs on one opened URL', async () => {
    const session = new BrowseSession(runtime, options());
    try {
      await session.open(`${site.baseUrl}/app`); // exploration that is not part of the flow
      await session.open(`${site.baseUrl}/products?page=1&sort=desc`);
      const items = (await session.read({ mode: 'items', selector: null })).items!;
      expect(items.count).toBe(3);
      const proposal: WorkflowProposal = {
        kind: 'list',
        name: 'list_products',
        title: 'List products',
        description: 'One page of the catalog in a chosen order.',
        entity: 'product',
        inputs: [
          { name: 'page', type: 'string', required: true, description: 'Page number', example: '1', actionIndex: 1, mode: 'value' },
          { name: 'sort', type: 'string', required: false, description: 'asc or desc', example: 'desc', actionIndex: 1, mode: 'value' },
        ],
        extract: { kind: 'item-list', item: 'ul.grid > li', fields: [{ name: 'name', selector: 'a', attr: null }, { name: 'url', selector: 'a', attr: 'href' }], hrefPattern: null, maxItems: 20 },
        resultUrlPattern: null,
        expectedOutcome: 'Three products.',
        confidence: 0.8,
        evidence: [],
      };
      const cap = session.buildWorkflowCapability(proposal, site.baseUrl);
      const program = cap.mechanics.program as Array<Record<string, unknown>>;
      expect(program.filter((s) => s['op'] === 'navigate').map((s) => s['url'])).toEqual([`${site.baseUrl}/products?page={{page}}&sort={{sort}}`]);
      const tool = generateProgramTool(cap, { ...model, site: { ...model.site, origin: site.baseUrl } }, { pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 })!;
      const run = await executeTool(runtime, tool, { page: '2', sort: 'asc' }, { scope, pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 });
      expect(run.ok, run.errorMessage).toBe(true);
      expect((run.output as { results: Array<{ name: string }> }).results.map((r) => r.name)).toEqual(['Product 4', 'Product 5', 'Product 6']);
      // An optional input left out keeps the session's value (desc): page 1 in descending order.
      const defaulted = await executeTool(runtime, tool, { page: '1' }, { scope, pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 });
      expect(defaulted.ok, defaulted.errorMessage).toBe(true);
      expect((defaulted.output as { results: Array<{ name: string }> }).results.map((r) => r.name)).toEqual(['Product 6', 'Product 5', 'Product 4']);
      expect(() => session.buildWorkflowCapability({ ...proposal, inputs: [{ ...proposal.inputs[0]!, example: '9' }] }, site.baseUrl)).toThrow(/does not contain the example value "9"/);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('waits for results a client-rendered page shows late, and returns an empty answer when there are none', async () => {
    const session = new BrowseSession(runtime, options());
    try {
      // The summary is read after the app's own call returned, not over its placeholders.
      const opened = await session.open(`${site.baseUrl}/late?n=3`);
      expect(opened.textSample).toContain('Train 3');
      const cap = session.buildWorkflowCapability(
        {
          kind: 'search',
          name: 'list_departures',
          title: 'Departures',
          description: 'Departures shown after the app loads them.',
          entity: 'trip',
          inputs: [{ name: 'how_many', type: 'string', required: true, description: 'How many', example: '3', actionIndex: 0, mode: 'value' }],
          extract: { kind: 'item-list', item: 'li.trip', fields: [{ name: 'time', selector: 'span.time', attr: null }, { name: 'train', selector: 'span.train', attr: null }], hrefPattern: null, maxItems: 20 },
          resultUrlPattern: null,
          expectedOutcome: 'Departures.',
          confidence: 0.8,
          evidence: [],
        },
        site.baseUrl,
      );
      const tool = generateProgramTool(cap, { ...model, site: { ...model.site, origin: site.baseUrl } }, { pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1000 })!;
      const late = await executeTool(runtime, tool, { how_many: '4' }, { scope, pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1000 });
      expect(late.ok, late.errorMessage).toBe(true);
      expect((late.output as { count: number; results: Array<{ train: string }> }).results.map((r) => r.train)).toEqual(['Train 1', 'Train 2', 'Train 3', 'Train 4']);
      // A first load that loses its own race is reloaded once.
      const flakyTool = { ...tool, program: tool.program.map((s) => (s.op === 'navigate' ? { ...s, url: `${s.url}&flaky=1` } : s)) };
      const flaky = await executeTool(runtime, flakyTool, { how_many: '2' }, { scope, pageLoadTimeoutMs: 6_000, settleTimeoutMs: 1000 });
      expect(flaky.ok, flaky.errorMessage).toBe(true);
      expect((flaky.output as { count: number }).count).toBe(2);
      const none = await executeTool(runtime, tool, { how_many: '0' }, { scope, pageLoadTimeoutMs: 4_000, settleTimeoutMs: 1000 });
      expect(none.ok, none.errorMessage).toBe(true);
      expect((none.output as { count: number }).count).toBe(0);
    } finally {
      await session.close();
    }
  }, 90_000);

  it('finds the whole result card, not the fare rows inside it, and refuses a program that would send a fixed date', async () => {
    const session = new BrowseSession(runtime, options());
    try {
      await session.open(`${site.baseUrl}/trips?date=2026-11-12&returnDate=2026-11-12&lang=en`);
      const items = (await session.read({ mode: 'items', selector: null })).items!;
      expect(items.item).toMatch(/div\.trip-card$/);
      expect(items.count).toBe(2);
      expect(items.fields.map((f) => f.selector)).toEqual(expect.arrayContaining(['div.head > span.dep', 'div.head > span.train']));
      const proposal: WorkflowProposal = {
        kind: 'search',
        name: 'find_trips_on',
        title: 'Trips on a date',
        description: 'Trips on a date.',
        entity: 'trip',
        inputs: [],
        extract: { kind: 'item-list', item: items.item, fields: [{ name: 'departure', selector: 'span.dep', attr: null }], hrefPattern: null, maxItems: 20 },
        resultUrlPattern: null,
        expectedOutcome: 'Trips.',
        confidence: 0.8,
        evidence: [],
      };
      expect(() => session.buildWorkflowCapability(proposal, site.baseUrl)).toThrow(/always send date=2026-11-12, returnDate=2026-11-12: a fixed date goes stale/);
      const cap = session.buildWorkflowCapability({ ...proposal, inputs: [{ name: 'travel_date', type: 'string', required: true, description: 'YYYY-MM-DD', example: '2026-11-12', actionIndex: 0, mode: 'value' }] }, site.baseUrl);
      const nav = (cap.mechanics.program as Array<Record<string, unknown>>).find((s) => s['op'] === 'navigate')!;
      expect(nav['url']).toBe(`${site.baseUrl}/trips?date={{travel_date}}&returnDate={{travel_date}}&lang=en`);

      // An optional return date follows the travel date instead of defaulting to the literal date browsed.
      await session.open(`${site.baseUrl}/trips?date=2026-11-12&returnDate=2026-11-14&lang=en`);
      const travel = { name: 'travel_date', type: 'string' as const, required: true, description: 'YYYY-MM-DD', example: '2026-11-12', actionIndex: 1, mode: 'value' as const };
      const back = { name: 'return_date', type: 'string' as const, required: false, description: 'YYYY-MM-DD.', example: '2026-11-14', actionIndex: 1, mode: 'value' as const };
      const roundTrip = session.buildWorkflowCapability({ ...proposal, name: 'find_round_trips', inputs: [travel, back] }, site.baseUrl);
      const nav2 = (roundTrip.mechanics.program as Array<Record<string, unknown>>).find((st) => st['op'] === 'navigate')!;
      expect(nav2).toMatchObject({ url: `${site.baseUrl}/trips?date={{travel_date}}&returnDate={{return_date}}&lang=en`, defaults: { return_date: '{{travel_date}}' } });
      const roundTool = generateProgramTool(roundTrip, { ...model, site: { ...model.site, origin: site.baseUrl } }, { pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 })!;
      expect(roundTool.inputSchema).toMatchObject({ required: ['travel_date'] });
      expect((roundTool.inputSchema as { properties: Record<string, { default?: unknown; description?: string }> }).properties['return_date']).toMatchObject({ description: 'YYYY-MM-DD. Defaults to travel_date when left out.' });
      expect((roundTool.inputSchema as { properties: Record<string, { default?: unknown }> }).properties['return_date']!.default).toBeUndefined();
      const oneWay = await executeTool(runtime, roundTool, { travel_date: '2026-12-01' }, { scope, pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 });
      expect(oneWay.ok, oneWay.errorMessage).toBe(true);
      expect((oneWay.output as { pageUrl: string }).pageUrl).toContain('date=2026-12-01&returnDate=2026-12-01');
      // With no required date to follow, an optional date becomes required.
      await session.open(`${site.baseUrl}/trips?returnDate=2026-11-14&lang=en`);
      const alone = session.buildWorkflowCapability({ ...proposal, name: 'find_returns', inputs: [{ ...back, actionIndex: 2 }] }, site.baseUrl);
      expect(alone.inputs).toEqual([expect.objectContaining({ name: 'return_date', required: true })]);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('completes inputs with schema defaults, never over a value the caller gave', () => {
    const schema = { type: 'object', properties: { from: { type: 'string' }, adults: { type: 'integer', default: 1 }, line: { type: 'string', default: 'N' } } };
    expect(withSchemaDefaults(schema, { from: 'RIY', line: 'E' })).toEqual({ from: 'RIY', adults: 1, line: 'E' });
    expect(withSchemaDefaults(undefined, { from: 'RIY' })).toEqual({ from: 'RIY' });
  });

  it('spots fixed dates in a URL template', () => {
    expect(fixedDatesIn('https://x.test/s?d={{date}}&r=2026-11-12&n=1')).toEqual(['r=2026-11-12']);
    expect(fixedDatesIn('https://x.test/day/12-11-2026/list')).toEqual(['12-11-2026']);
    expect(fixedDatesIn('https://x.test/s?d={{date}}&page=2')).toEqual([]);
  });

  it('binds an example as a whole query value or path segment before any other occurrence', () => {
    expect(bindInUrl('https://x.test/s?From=RIY&To=DMM&Lang=en', 'DMM', 'to')).toBe('https://x.test/s?From=RIY&To={{to}}&Lang=en');
    expect(bindInUrl('https://x.test/s?q=1&page=1', '1', 'page')).toBe('https://x.test/s?q={{page}}&page=1');
    expect(bindInUrl('https://x.test/cars/toyota-1/specs', 'toyota-1', 'slug')).toBe('https://x.test/cars/{{slug}}/specs');
    expect(bindInUrl('https://x.test/s?q=red%20car', 'red car', 'q')).toBe('https://x.test/s?q={{q}}');
    expect(bindInUrl('http://127.0.0.1:8080/s?n=3', '7', 'n')).toBe('http://127.0.0.1:8080/s?n=3');
  });

  it('lists embedded frames so the model can open a form that lives in one', async () => {
    const session = new BrowseSession(runtime, options());
    try {
      const s = await session.open(`${site.baseUrl}/framed`);
      expect(s.frames).toEqual([{ url: `${site.baseUrl}/app`, sameSite: true, visible: true }]);
      expect(s.elements.some((e) => e.name === 'Find trips')).toBe(false);
      const inner = await session.open(s.frames[0]!.url);
      expect(inner.elements.some((e) => e.name === 'Find trips')).toBe(true);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('summarizes only the site own requests, one line per method and path, API calls first', () => {
    const rec = (method: string, url: string, extra: Partial<NetworkRecord> = {}): NetworkRecord => ({ at: '', context: { pageUrl: '' }, resourceType: 'xhr', method, url, credentialed: false, inScope: true, ...extra });
    const own = (url: string) => new URL(url).hostname.endsWith('example.com');
    const { requests, otherRequests } = summarizeRequests(
      [
        rec('GET', 'https://www.example.com/assets/i18n/en.json'),
        rec('POST', 'https://telemetry.vendor.io/collect', { error: 'refused: write' }),
        rec('GET', 'https://www.example.com/page'),
        rec('POST', 'https://api.example.com/Login', { status: 200, responseShape: { kind: 'object', keys: ['Token'] }, allowedAs: 'app-request' }),
        rec('POST', 'https://api.example.com/GetGenericCall', { status: 200, responseContentType: 'text/plain; charset=utf-8', bytes: 54354, allowedAs: 'app-request' }),
        rec('POST', 'https://api.example.com/GetGenericCall?x=2', { status: 200, responseContentType: 'text/plain; charset=utf-8', bytes: 274, allowedAs: 'app-request' }),
        rec('GET', 'https://www.example.com/app.js', { resourceType: 'script' }),
      ],
      own,
    );
    expect(otherRequests).toBe(2);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST https://api.example.com/Login', 'POST https://api.example.com/GetGenericCall', 'GET https://www.example.com/page']);
    expect(requests[1]).toMatchObject({ responseType: 'text/plain', bytes: 54354, times: 2 });
    expect(requests[0]!.responseType).toBeUndefined();
  });

  it('declares strict browsing tools', () => {
    const tools = browseToolDefinitions();
    expect(tools.map((t) => t.name)).toEqual(['browse_open', 'browse_act', 'browse_read', 'propose_workflow']);
    for (const t of tools) expect(t.strict && t.input_schema.additionalProperties === false).toBe(true);
  });
});
