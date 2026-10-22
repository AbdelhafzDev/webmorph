# WebMorph implementation roadmap

Phased delivery of [plan.md](../plan.md), shaped by the findings in [plan-review.md](../plan-review.md). Each phase ends with something runnable and tested. Later phases only start when the earlier phase's acceptance criteria are met on the fixture sites.

Decisions that the plan left open are recorded in [decisions.md](decisions.md).

| Phase | Scope | Plan stages | Status |
|---|---|---|---|
| 0 | Foundations: repo, artifact contracts, store, job runner | Section 7 | Done |
| 1 | Deterministic discovery | Stages 0, 2, 3 | Done |
| 2 | Browser inspection | Stages 4, 5, 6 | Done |
| 3 | Website model and tool generation | Stages 8, 10 | Done |
| 4 | Agent adapter (MCP) | Section 8, runtime | Done |
| 5 | Documentation discovery and network evidence | Stages 1, 7 | Done |
| 6 | Recording (Mode A) and workflows | Section 6, Stage 9 | Done |
| 7 | Studio (review UI) | Section 3 | Done |
| 8 | Skill generator (Layer 3) | Section 8 | Done |
| 9 | Model harness: the model explores and proposes, code validates | D26 | Done |

## Phase 0: Foundations

Deliverables:

- TypeScript project on Node 20+, ESM, strict mode, vitest.
- Artifact envelope and per-type schemas in Zod, exportable to JSON Schema (`webmorph schemas export`).
- File-backed artifact store. Artifacts are immutable per job; the store refuses to overwrite.
- Job record with per-stage status and a sequential stage runner. No DSL, no external workflow engine.

Acceptance: `pnpm test` passes; schemas export cleanly.

## Phase 1: Deterministic discovery

Deliverables:

- Stage 0: URL normalization, scope policy, SSRF guard (blocked hostnames, private and link-local ranges, DNS resolve-and-check, pinned connections), budgets. Produces `SiteManifest`.
- Safe HTTP client: per-hop redirect checks against scope and SSRF, response size cap, timeouts, bounded retries honoring `Retry-After`, per-host politeness delay, concurrency limit, request budget.
- Stage 2: robots.txt and sitemap discovery with limits on files, URLs, depth and bytes. Supports sitemap indexes, gzip, and plain-text sitemaps; the URL budget is shared round-robin across sitemap files so every section of a large site is represented. Produces `URLInventory` including route candidates.
- Stage 3: static crawl seeded from the start URL, `llms.txt` links and the sitemap, sampled by URL shape so a small page budget covers every section (decision D22); sitemap evidence lets two crawled siblings form a template. HTML extraction (title, metadata, canonical, headings, links, forms, scripts, JSON-LD), render-mode probe (static, hybrid, SPA shell), template grouping by URL pattern with DOM skeleton cohesion, bot-protection detection. Produces `PageInventory`, `PageTemplates`, `CrawlReport`.
- CLI: `webmorph discover <url>`.
- Fixture site served from a local HTTP server for end-to-end tests.

Acceptance: end-to-end test against the fixture site produces all four artifacts; SSRF tests block private targets; SPA shell is detected; bot challenge pages are marked `blocked` and never retried with evasion.

## Phase 2: Browser inspection

- Stage 4: inspection plan from templates and render modes. Representative pages per template; SPA sites go browser-first.
- Stage 5: Playwright inspection in an isolated context. Accessibility snapshot, element inventory with ranked locator candidates (test ID, role and name, label, stable CSS, text), element role classification, screenshots and DOM snapshots as blobs.
- Stage 6: targeted interactions with a fresh context per probe, state-based waits, before and after diffs, per-page and per-site action budgets. Safe-interaction allowlist: GET forms and known search or filter patterns only.
- Browser-side SSRF and scope enforcement through request interception.

Acceptance: element inventory for the fixture site includes a search form with a stable locator; interaction probe records a URL change for a search submission; no POST form is ever submitted without an explicit allow flag.

Delivered: `InspectionPlan`, `PageModel`, `ElementInventory`, `InteractionEvidence` and `StateTransition` artifacts; a browser runtime that applies the scope and SSRF policy to every request; ranked locators with uniqueness measured at inspection time; six read-only probe kinds deduplicated across pages; an evaluation wrapper that keeps in-page scripts working under every transpiler. Known gaps for later phases: locator stability is measured on one load only, cookie-consent dialogs are detected but not dismissed, and SPA sites are planned from URL inventory rather than from rendered navigation.

## Phase 3: Website model and tool generation

- Tool definition schema: declarative step programs (navigate, fill, click, wait-for, extract) interpreted by the runtime. No generated code.
- Stage 8: structured extraction with Claude using schema-constrained output. Observed facts cite evidence IDs; inferred statements carry confidence. Page content is passed as data, never as instructions.
- Stage 10: replay validation in a fresh browser, output schema validation, locator stability across N runs, tool status lifecycle (draft, validated, published, degraded, disabled).

Acceptance: a read-only search tool for the fixture site validates on replay and fails cleanly when the fixture's markup is changed.

Delivered: `WebsiteModel`, `ToolDefinition` and `ValidationReport` artifacts; a deterministic model builder where every capability, fact and hypothesis cites evidence; Claude enrichment through the SDK's schema-constrained output with a grounding filter (unknown page types, capability IDs or fact IDs are rejected); search, list and detail tools generated as declarative programs with JSON Schema contracts; an interpreter with a typed error taxonomy; replay validation with five checks; `webmorph run-tool`. Known gaps: only read-only GET-based capabilities become tools, list extraction is link-based (no per-item fields yet), the live Claude call is untested in this environment (no credentials), and tool status changes live in the validation report rather than a mutable registry (Phase 4).

## Phase 4: Agent adapter

- MCP server exposing published tools with typed schemas.
- Runtime execution: pooled browser contexts, per-site concurrency limits, timeouts, error taxonomy (`INPUT_INVALID`, `PRECONDITION_FAILED`, `LOCATOR_MISSING`, `AUTH_REQUIRED`, `SITE_CHANGED`, `BLOCKED`).
- Side-effect class enforcement: only `read` tools are callable without an approval policy.

Delivered: a mutable per-site registry pinned to job and artifact IDs with publish, disable, enable and revalidate commands; a `ToolExecutor` with one browser per site, a fresh context per call, bounded concurrency, per-call timeouts, policy checks before dialing, call statistics and automatic degradation after consecutive site-change failures; an MCP server over stdio exposing published tools with JSON Schema inputs and outputs, read-only annotations and structured results; a `call` command. Known gaps: stdio only (no HTTP transport), no session support, and approval is a CLI action rather than a Studio review.

## Phase 5: Documentation and network evidence

- Stage 1: `llms.txt`, OpenAPI and docs discovery. Documentation is site-controlled input and is recorded as evidence, never trusted over observed behavior.
- Stage 7: network capture with header allowlist and body redaction. API candidates are hypotheses for review.

Delivered: `DocumentationIndex` with OpenAPI 3, Swagger 2 and llms.txt parsing; redacted network capture in the browser runtime with per-page and per-probe tagging; `NetworkEvidence` and `ApiCandidates` with documented-operation matching; capability-to-API linkage from documentation and observed traffic; HTTP tool variants with an `http` step and JSON extraction, validated by replay and served without a browser. Since D25 tools are API first (HTTP route under the capability name, browser as `_browser`, server-rendered result lists as `html-list` tools, `apiGaps` for the rest). Known gaps: only GET APIs with query or path inputs are generated, response schemas are generic (`data`), llms-full.txt content is stored but not mined, and documentation pages feed facts only, not capabilities.

## Phase 6: Recording and workflows

- Mode A recording in a headed local Playwright browser. Field semantics recorded; typed values redacted by default.
- Stage 9: workflow reconstruction from recordings and interaction evidence.

Delivered: a recorder on top of the policed browser runtime with in-page instrumentation, semantic event capture, before and after states, optional screenshots, streamed JSON Lines, and credential redaction inside the page; `RecordingSession` and `WorkflowDefinition` contracts; Stage 9 reconstruction into interpreter steps with per-step evidence, consequential-control detection and replayability; workflow tools generated, validated by replay when read-only, skipped otherwise, and unpublishable when they write; `record` and `recordings` commands. Known gaps: Mode B (extension in the user's own browser) is out of scope; workflows are not yet merged with probe evidence; intent labels are heuristic until the model enrichment covers workflows; branches and retry conditions are recorded only as reasons. A click on one of several similar links (a search result, a listing item) is reconstructed as a `click-result` step with optional `result_title` and `result_index` inputs, defaulting to the first match, so replays with different queries still work.

## Phase 7: Studio

- Review UI over the artifact store: pages, templates, evidence, candidate tools, approve and publish.

Delivered: `StudioServer` with a JSON API over sites, jobs, artifacts, evidence logs, blobs, recordings and the registry, plus write endpoints for publishing, status changes, tool calls, revalidation and discovery runs with live logs; a single-document UI with tabs for overview, pages, inspection, probes, docs, model, tools, workflows, recordings and registry, a try-it form built from each tool's input schema, and a discover form. Loopback only, no authentication, data rendered through DOM APIs only. Known gaps: no multi-user review or audit trail beyond the registry history, no editing of generated tools, and no diff view between jobs.

## Phase 8: Skill generator

The third capability layer of the plan: compose a site's published tools into a reusable skill.

- A `SkillDefinition` artifact per site (the type is already reserved in the artifact enum), generated from the registry and the validation report: purpose and entities of the site, the published tools grouped by intent (find, list, look up), how one tool's output feeds another (a result URL or identifier into the detail tool), the meaning of each error code on this site, worked examples taken from validation runs, and the MCP server configuration that serves the tools.
- Rendered as a `SKILL.md` bundle an agent can load as one unit, with the tool schemas beside it; every statement cites the tools and evidence behind it, and the bundle is regenerated, never hand-edited, when tools are republished or degraded.
- Published through the registry like tools, so an operator approves a skill before agents see it, and served by the MCP server as a resource beside the tools.

Acceptance: the fixture site yields a skill that names its search, list and detail tools with the result-to-detail hand-off, and an agent following only the skill completes a search-then-detail task against the fixture.

Delivered: `SkillDefinition` (stage 11, optional, after validation) with model-written guidance grounded by code (only validated tools and real inputs, examples computed from validation runs, instruction-like text dropped) and a template fallback; `webmorph skill <siteId>` renders `SKILL.md`, `tools.json` and `mcp.json`. Known gaps: the skill is not yet gated by the registry (an operator publishes tools, not skills), not served as an MCP resource, and the search-then-detail acceptance task has not been run by a live agent.

## Phase 9: Model harness

Decision D26: the model is the harness. Delivered: a tool-using loop in stage 8 (`src/model/agent.ts`) with evidence reads, policed HTTP and browser reads, entity and capability revisions, and capability proposals that are generated into tools and replayed before they are kept; budgets for turns, reads, inspections, proposals and tokens; a full record under `WebsiteModel.agent`; model-chosen inspection plans in stage 4 with the heuristic plan as fallback and ceiling; `FakeChatClient` for scripted end-to-end tests. First live run (2026-10-22, `gpt-5.5` on the fixture site): the model chose 6 of 13 pages to inspect, ran 11 turns with 27 tool calls, proposed 3 capabilities that all validated (the observed GraphQL `SearchPosts` query as `search_posts`, a `documentation_page` entity with `list_documentation_pages` and `get_documentation_page`), renamed `get_post` to `get_blog_post`, and wrote the skill guidance with one instruction-like statement rejected; 193k input tokens (166k cached) and 3.3k output tokens.

Live runs against a real site (2026-10-22, `gpt-5.5` on `www.sar.com.sa`, a Gatsby information site with a third-party chat widget): the first two runs exposed six gaps, fixed the same day. A widget cookie named `sessionId` had made every `page-data` endpoint credentialed and unpromotable; the skill grounding dropped the model's overview for naming the site's own URL and five hand-offs for listing two inputs in one field; the model spent all sixteen turns without calling `finish`; a heuristic entity (`ar`, from `/ar/404/`) outlived its dropped capability and leaked into the purpose sentence; and single fixed pages validated as tools. Now a candidate flagged only by a cookie name is generated and the cookie-less replay decides (D21 addendum), the site's own URLs are allowed in skill prose, multi-input hand-offs are split, the harness reminds the model two turns before the budget and writes a deterministic purpose when `finish` never comes, orphan entities are dropped, and no-input proposals are refused unless a listing returns three or more results. The rerun after the fixes: 15 turns, 24 tool calls, `finish` called after the reminder, a model-written purpose, two proposals kept over the cookie-flagged `page-data` endpoints (`get_content_page_data(page_path)` validated by replay in 258 ms, plus `get_content_page(page_path)` with a browser fallback), three rejected for citing evidence that did not exist, the `ar` entity dropped, and a model-written skill with no statement rejected; 366k input tokens (316k cached) and 3.9k output tokens. Known gaps: the Anthropic account used had no credits, so the Claude path is verified only against a stub; stage 6 probe selection is still heuristic; proposals are validated with one replay run rather than the full `validationRuns`; the three-results rule counts link lists only, so a no-input listing over a JSON endpoint is refused until stage 8 counts JSON arrays; the model's remaining rejections are evidence references it invented, which the harness could answer with the references that do exist.

## Measurement before a release

Independent of the phases above: a benchmark over a fixed set of live sites (`bench/`, `pnpm bench`): several runs per site with one budget, scored from the artifacts for tools validated by transport, whether the site's main task is covered and by how many required inputs, harness turns and tokens, and wall time, with the baseline committed under `bench/results/` so each change shows a delta per site. Still open: typed response schemas for JSON API tools; scheduled revalidation to report replay stability over time.
