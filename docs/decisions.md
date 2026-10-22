# Decisions

Architecture decisions for the points the plan left open. Each is reversible, but changing one after Phase 2 is expensive.

## D1. Language and runtime: TypeScript on Node 20+

Playwright and the MCP SDK are first-class in TypeScript, and the Studio will be a web UI. One language across runtime, adapter and UI. ESM modules, strict compiler settings.

## D2. Hosting model: local-first library and CLI

WebMorph runs as a library with a CLI on the operator's machine. A server deployment comes later and reuses the same stages. Consequences: Mode A recording uses a headed local browser, no remote browser streaming is needed for v1, and the artifact store is the local filesystem.

## D3. v1 customer: public websites, read-only capabilities

The first release targets publicly reachable sites and produces read-only tools (search, list, detail). Authenticated sessions, site-owner verification and consequential actions are deferred. This matches the plan's deterministic-first pipeline, which contributes little on SSO-gated single-page applications.

## D4. Tools are data, not code

A website-specific tool is a declarative step program interpreted by the browser runtime. The LLM proposes steps and schemas; it never emits executable code. This is what makes validation, diffing, versioning and permission enforcement tractable.

## D5. Artifacts: JSON files, immutable per job

Artifacts live under `.webmorph/sites/<siteId>/jobs/<jobId>/artifacts/<Type>.json` with a common envelope (schema version, site, job, stage, sources, provenance). The store refuses to overwrite. Large evidence uses JSON Lines; binary evidence lives under `blobs/`. The job record is the only mutable file.

## D6. Orchestration: a job record and a sequential runner

Stages communicate only through persisted artifacts. The runner records per-stage status, supports resume, and stops on a required stage failure while continuing past optional ones. No DSL and no external workflow engine until the measurements call for one.

## D7. Schemas: Zod is the source of truth

Every artifact type is a Zod schema. JSON Schema is exported from it for consumers in other languages. Schema versions are explicit strings in each envelope.

## D8. Bot protection: stop and mark, never evade

A 403, 429 or JavaScript challenge is recorded as `blocked` with the detected signal. The crawler never rotates identities, solves challenges or otherwise evades access controls. A site with blocked responses and no successful pages is marked blocked at the site level.

## D9. robots.txt is respected by default

Disallowed paths are recorded but not fetched. An operator can override with `--ignore-robots` for sites they own. The crawler identifies itself with a `WebMorph` user agent.

## D10. Scope is exact hostnames

Allowed hosts are the start hostname, its `www.` or apex counterpart, and any hosts the operator adds. Redirects and links to any other host are recorded as out of scope and never followed.

## D11. SSRF defense in depth

Blocked hostnames (localhost, `.local`, `.internal`, cloud metadata), private and reserved IPv4 and IPv6 ranges (including IPv4-mapped and NAT64 forms), DNS resolve-and-check before the first request, and a pinned lookup on the connection so the address that was checked is the address that is dialed. Every redirect hop is checked again. Private targets are allowed only with an explicit `--allow-private` flag, which the test suite uses for its fixture server.

## D12. URL normalization

Lowercase scheme and host, default ports removed, fragments removed, tracking parameters (`utm_*`, `fbclid`, `gclid` and similar) removed, remaining query parameters sorted, trailing slash removed except at the root. Normalization is for deduplication; the originally observed URL is kept in the inventory sources.

## D13. The model enriches; it never decides mechanics

Stage 8 builds the website model deterministically first. Claude may then add a purpose statement, entity and capability descriptions, and hypotheses, through schema-constrained output. Every hypothesis must cite fact IDs and every entity must cite page type IDs that exist; anything else is dropped and recorded under `enrichment.rejected`. Mechanics (URLs, parameters, locators, side-effect class, auth requirement) come only from evidence. Page text reaches the model as JSON data with an explicit instruction to ignore instructions inside it. Enrichment failure, including missing credentials or a refusal, is recorded and never fails the stage.

## D14. Validation decides status, and a tool is validated only against the live site

Generated tools start as drafts. Stage 10 replays each tool with its evidence-derived example inputs, at least twice, and requires five checks to pass: runs succeed, output matches the schema, output is non-empty, results are stable across runs, latency is within the tool timeout. The verdict and reasons are recorded per tool. Artifacts stay immutable, so the status after validation lives in the validation report; a mutable published-tool registry pinned to artifact versions arrives with the agent adapter.

## D15. Search queries for probes and validation come from site vocabulary

A probe that submits a search uses the most frequent word in the page's in-scope link texts, falling back to a heading word. This keeps probes harmless, plausible and likely to return results, which the non-empty-output check relies on.

## D16. Browser traffic is policed at the connection and at the request

Playwright's route handlers see only the first request of a redirect chain, and Chromium resolves DNS on its own. Neither can carry the SSRF guarantee alone. So the browser runs behind a local policy proxy that resolves and pins every host (the SSRF layer, including redirect hops and WebSockets), and the route handler performs each fetch with redirects disabled, checking scope, method and resource type per hop (the policy layer). Document redirects are handed back to the navigator as explicit navigations so the page URL stays truthful. Non-GET requests are refused unless the operator enabled write probes, and then only to in-scope hosts.

## D17. Publishing is an operator action, and the registry pins what it publishes

Validation produces a verdict; it does not publish. An operator publishes validated tools into a mutable per-site registry, where each entry is a snapshot pinned to the job and artifact IDs it was validated against. Later discovery runs never touch published tools. At call time the executor refuses anything that is not published, read-only and session-free, and degrades a tool after two consecutive failures that implicate the site rather than the caller. Degraded tools stay refused until revalidated, so agents never retry blindly against a changed site.

## D18. APIs are preferred over the browser only when they are public, read-only and evidenced

A capability gains an API mechanic when a documented GET operation or observed GET traffic matches it. A tool is generated from that mechanic only when the operation needs no authentication, the observed requests carried no credentials, and the method is GET. The API tool is published beside the browser tool, not instead of it, so an agent can prefer the cheaper path while the browser path remains the fallback. Observed traffic is evidence of what the site's own front end does; WebMorph never replays requests it saw outside validation of a generated tool, and it never calls endpoints that were only visible with a session.

## D19. A recording is the person's actions, and a replay is only ever of read-only steps

The recorder captures what the person did, in the browser WebMorph owns, under the same network policy as discovery but with writes allowed because a human is performing them. Values are kept only when the operator asks, and credential-like fields are redacted inside the page before anything reaches the process. Reconstruction turns observed actions into steps without inventing any; the only inferred part is the intent label. A workflow whose steps write or act on consequential controls is marked as requiring approval, is never replayed by validation, and cannot be published, so a recording of a checkout can inform the model without ever being executed by an agent.

## D20. The Studio is a local, single-operator surface over the same store

The Studio adds no new state of its own: it reads artifacts, evidence and recordings from the store and writes only through the registry and the executor, the same paths the CLI uses. It binds to loopback with no authentication because WebMorph is local-first (D2); exposing it beyond one machine would require authentication, an audit trail and per-user approvals, which belong to a later hosted deployment. The page renders all data through DOM construction rather than HTML strings so site-controlled text can never execute in the operator's browser.

## D21. GraphQL queries are reads, and anonymous cookies are not credentials

A POST whose JSON body is only GraphQL `query` operations is treated as a read by the browser method policy, captured with its operation name and redacted variables, and may back a tool; mutations and subscriptions stay refused. A request counts as credentialed when it carries an authorization-style header or a cookie whose name looks like a session or token; load-balancer, analytics and preference cookies that every anonymous visitor receives do not disqualify an endpoint. The replay during validation runs without any cookies, which is the real test of whether an endpoint is public. Hosts on the site's registrable domain (`graphql.haraj.com.sa` for `haraj.com.sa`) are the site's own for API purposes; document navigation scope stays exact-host.

Addendum (2026-10-22, after the SAR runs). A cookie name is not a credential, and the replay is the test. A third-party chat widget on sar.com.sa set a cookie named `sessionId`, which made every Gatsby `page-data` endpoint credentialed and kept the generator from ever reaching the cookie-less replay that would have proved them public. The flag now records its source: a candidate is credentialed by `header` when any observed request carried an authorization-style header that no operator-configured credential explains (D23), and by `cookie` when only cookie names flagged it. A header keeps the candidate unpromotable, in the generator and in the harness. A cookie-only candidate is generated into an HTTP tool whose precondition says so, the tool sends no cookies, and validation decides: a 401 or 403 on replay fails it as `PERMISSION_DENIED`. Nothing observed is ever replayed on its own authority; what changed is that a cookie name alone no longer prevents the generated tool from being tried.

## D22. A small crawl is a sample across the site's sections, not a breadth-first walk

Template discovery needs a few pages of every section, not many pages of one. Three rules make a 30-page budget cover a 30,000-URL site: the sitemap stage admits URLs round-robin across child sitemaps instead of filling its budget from the first one; the crawl frontier hands out pages by URL shape (depth plus leading section, with every top-level one-off page counted as one shape) so no shape takes a third page before every shape has had two, with rank deciding only among equals; and links from `llms.txt` are seeded ahead of homepage links because they are the pages the site itself points agents at. Two crawled siblings generalize to `{slug}` when the URL inventory proves the family is large, so the sampler's thrift does not cost the templates their patterns. A generalized `/section/{slug}` template whose pages declare an `ItemList` is a listing with a path input, not an entity page. Locale variants of one capability are named by locale (`search_cars`, `search_cars_ar`) rather than numbered.

## D23. Discovery never captures a credential; a configured credential is the operator's statement that the site allows its use

Some public APIs are keyed: the site's own front end sends a publishable key, the same for every visitor and shipped in its JavaScript bundle, and the endpoint answers 401 without it (Syarah's search API is one). Discovery still records such a request as credentialed and never keeps the value: evidence holds the names of the credential headers it saw, never their contents, and nothing WebMorph observed is ever replayed on its own authority. What changes is that an operator may configure a credential for a host and header (`webmorph discover --api-credential 'search-api.example.com:authorization=Bearer …'`, a JSON file, or `webmorph credentials set`). Configuring it is the operator's statement that the site permits the key to be used this way; WebMorph does not infer permission from a key's prefix, its presence in a bundle, or anything else it sees.

The value lives in exactly one place, the mutable per-site config beside the registry, written owner-only and outside the immutable job folders. The manifest records the credential by reference (name, host, header), so a job stays reproducible without carrying the secret. Stage 7 reclassifies an observed request whose only credential is a header matching a configured credential's host and header name as *configured* rather than *credentialed*: the candidate names the credential, the model may link it, and the generator emits the `_api` tool with a `credentialRef` on its http step. The interpreter resolves the reference from the site config at run time, sends the header only to the host the credential was configured for and only on the first origin of a redirect chain, and refuses with `PERMISSION_DENIED` when the reference is not configured. Validation replays with the credential; the executor and the MCP server pass it through unchanged. Only read-only endpoints qualify, exactly as without a credential: GET, or GraphQL `query` operations over POST. A session cookie, a per-visitor token, or a second unconfigured credential header on the same request keeps it credentialed and unpromoted.

## D24. An embedded JSON shape is evidence from one page: described in the schema, never enforced by it

A page-data tool returns whatever JSON objects a detail page inlines (`window.FULL_PAGE_DATA`, `__NEXT_DATA__`, `application/json` scripts), and on sites like Syarah that object is the richest data the tool returns. An agent can only use it if the tool says what is in it, so the generator reads the representative detail page once more through the safe HTTP client (the crawl keeps no HTML) and puts the embedded objects' key names and observed value kinds into the output schema under `embedded`, two levels of keys deep and at most 40 keys per level, with a one-line list of the keys in the tool description. The sample page's URL is cited in the schema and in the tool's evidence.

Two rules bound what that shape may claim. First, it carries names and kinds only, never values: a value from the sample would be site content copied into a definition that agents read, and keys whose names look like credentials or personal data (`token`, `session`, `email`, `phone`) are named with no kind and no children, so a shape cannot leak the structure of a secret either. Second, the shape constrains nothing. It is written as JSON Schema annotations (`properties` and `description`, with `additionalProperties: true` and no `type` below `embedded`), because the interpreter checks every output against the schema and MCP clients validate structured results against it with Ajv: a `type: number` learned from one page would fail the call on the next page where that key is null or a string, and two such failures would degrade a working tool under D17. One page is evidence of what the site publishes, not a contract; the enforced part of the contract stays the envelope the extractor guarantees (`url`, `status`, `title`, `jsonLd`, `embedded`). A sample that cannot be read leaves the shape undescribed and the tool otherwise unchanged; it never fails generation.

## D25. API first: the HTTP route carries the capability's name, and a server-rendered result list is an API

The product is tools an agent can call without a browser. Every read capability therefore gets its HTTP route first and the browser route only as a fallback: the HTTP tool takes the capability's own name (`search_cars`, `get_car`), the browser tool is `search_cars_browser` when an HTTP route exists and plain otherwise, and the MCP server lists HTTP tools first. There are three HTTP routes, tried in order: the site's documented or observed public JSON or GraphQL endpoint, the structured data a detail page publishes, and the result list a listing or search page already contains in its HTML. The third is new here: during generation the landing page is read once with the example inputs, and when three or more result links are in the HTML the capability gets an `html-list` tool that fetches the page and parses the links, enriched with the page's schema.org `ItemList` offers (price, currency, availability, condition, image). A page that renders its results client-side gets no such tool. A capability with no HTTP route is recorded as an `apiGaps` entry with a reason (client-rendered, credentialed, write, no sample, no mechanics), so the output states what the site would have to allow rather than leaving an agent to discover it by trial.

## D26. The model is the harness: it reads, explores and proposes; code bounds every read and the replay decides

Supersedes the second half of D13. The product is an LLM harness that turns any website into tools and skills, so the model does the understanding and the deterministic pipeline does the enforcing. Stage 8 starts from the deterministic model and hands it to the model as data with a set of tools: read evidence records, read a page or JSON endpoint over the policed HTTP client, open a page in the policed browser, add or rename entities, revise or drop capabilities, record the site's purpose and hypotheses, and propose a capability with its mechanics and the evidence it rests on. Every proposal is generated into tools and replayed against the live site at once; it is kept only when a tool validates, and the model is told why otherwise so it can fix the mechanics. Stage 4 lets the model choose which candidate pages to inspect, within the heuristic candidates and the budget, and never with more interactions than the heuristic policy allows. Stage 11 has the model write the guidance of a skill from the validated tools and the validation report.

Three things stay in code whatever the model says. The safety policy: scope, SSRF, read-only methods, robots, credentials by reference; every tool the model calls goes through the same clients the stages use, so the model cannot widen scope, send a write, or replay a credential it saw. The evidence: a proposal must cite records that exist, and what the model read is recorded, so its claims can be checked. The verdict: a capability exists in the model only after a generated tool validated by replay, and a skill may name only validated tools, with its examples computed from validation runs rather than written by the model. Text from the model that reads like an instruction to a downstream agent is dropped (as before), everything it receives is labelled as data from a third-party site, and the harness runs under budgets for turns, reads, inspections, proposals and tokens that the operator sets. Without a model, or when the model errs or declines, every stage keeps its deterministic result and records why, so a run never fails because the model did.

## D27. The model drives the browser; a page's own requests are the page's business

A coding agent given the same site produced a journey search in a day because it could drive a browser and write a parser; the harness of D26 could only look, propose URLs and cite evidence, and its method policy blanked the booking application before anything could be observed (the app logs in as a guest with a POST on load). Three changes follow.

First, the model may drive the policed browser through harness tools: open a page (on an in-scope or same-site host), click, fill, select and press on elements the inventory describes, read text and repeated items, and see which requests each action caused. The guardrails are the recorder's: never a consequential control, never a control in a consent or authentication dialog, never a field of a type WebMorph does not fill (password, email, telephone, file, hidden), never a form with sensitive fields, never a document-level POST, and a budget of actions. Every action is recorded with the element's locators, and the model turns a session into a tool with `propose_workflow`: it names the inputs and binds each to a recorded value or clicked option, chooses an extractor for the result (repeated items with per-field selectors, or a link list), and the harness builds the declarative program, generates the tool and replays it in a fresh context. It is kept only if it validates, like every other proposal.

Second, the method policy distinguishes WebMorph's actions from the page's own traffic. WebMorph still never submits a form, clicks a consequential control or sends a write of its own. But an XHR or fetch request the page issues to the site's own hosts (in scope or same-site) is allowed whatever its method, recorded as an app request, and never promoted to a tool unless it is a GraphQL query: a browser visit sends those requests anyway, and a single-page application cannot render without them. `strictMethods` restores the old GET-only policy. Third-party hosts stay GET-only, document-level POST stays refused, and `allowWrites` keeps its meaning for probes. Two limits keep the R6 guarantee: a GraphQL mutation or subscription is refused whatever issued it, and the allowance is a per-context switch that is on from navigation and after search, filter and pagination actions, and off before a toggle, tab, menu or dialog probe, so a page cannot hide a write behind a control WebMorph only opened to look.

Third, same-site hosts are navigable when a program or the model names them (a booking subdomain of the site), per context, without widening the manifest's exact-host scope for anything else.

## D28. WebMorph is a connector agent, not a pipeline with a model attached

Given the same site, a general coding agent produced a working connector in a day by driving a browser and writing bespoke code. WebMorph's job is that outcome, done better: a connector per site (validated tools, API first, plus a skill), produced by an agent that has purpose-built instruments instead of raw HTML and a code editor. The instruments are what the pipeline used to be: discovery evidence on demand (robots, sitemaps, sampled crawl, templates, documentation, network capture), a policed headless browser the agent drives (D27), a recorder a person can take over when a flow needs human hands, generation of declarative tools, and replay validation. The stages stop being a fixed sequence the agent decorates and become tools the agent calls when it needs them.

Three consequences. Efficiency is a design goal: evidence is read lazily and summarized, tool results are trimmed, the system prompt and evidence are cached, cheap reads may go to a smaller model, and the agent is judged by connectors per token, not by turns. The output stays data: a connector is tools (declarative programs and HTTP steps), their schemas, validation runs and a skill, so it is inspectable, replayable and publishable through the registry; an exported package (SKILL.md, tools.json, MCP configuration) is the deliverable, and generated code, if ever, is a rendering of that data, never the source of truth. The guarantees do not move: read-only actions, credentials only by an operator's decision, evidence behind every statement, and no tool without a passing replay.
