<h1 align="center">WebMorph</h1>

<p align="center">
  Turn an authorized website into validated, read-only tools that AI agents can call without a browser.
</p>

<p align="center">
  <a href="https://github.com/AbdelhafzDev/webmorph/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/AbdelhafzDev/webmorph/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-server-000000">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

WebMorph is a discovery and capability-generation pipeline. Deterministic stages collect evidence about a site (robots and sitemaps, a sampled crawl, browser inspection, interaction probes, redacted network capture, documentation). A website model is built from that evidence, every read capability becomes a typed tool, each tool is validated by replay against the live site, and an operator publishes the ones that passed to agents over the Model Context Protocol.

It is not a crawler, a browser recorder, or an autonomous browser agent. Tools are data, not code; HTTP tools come first and browser tools are the fallback; nothing WebMorph observed is ever replayed on its own authority.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/pipeline.dark.svg">
  <img alt="The WebMorph pipeline: deterministic discovery, browser evidence, website model, tools" src="docs/diagrams/pipeline.svg">
</picture>

Eleven stages, four groups. Each stage reads earlier artifacts and writes its own, immutable per job, so a run can be inspected, resumed and diffed. The full stage-by-stage description is in [docs/architecture.md](docs/architecture.md).

## What you get

An agent integration is judged by the API surface it exposes, so WebMorph generates tools API first: the HTTP route carries the capability's name (`search_cars`, `get_car`), the browser route is the `_browser` fallback, and capabilities with no HTTP route are reported as gaps with a reason.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/api-first.dark.svg">
  <img alt="API-first tool generation: JSON API, structured page data, server-rendered result list, browser fallback" src="docs/diagrams/api-first.svg">
</picture>

A tool is a declarative program with a JSON Schema contract, preconditions, error cases, example inputs and evidence pointing back at the artifacts that justify it:

```jsonc
{
  "name": "search_products",
  "transport": "http",
  "sideEffectClass": "read",
  "inputSchema": { "type": "object", "properties": { "query": { "type": "string", "minLength": 1 } }, "required": ["query"] },
  "program": [
    { "op": "http", "method": "GET", "url": "https://shop.example/api/products", "query": { "q": "query" }, "accept": "application/json" },
    { "op": "extract", "extractor": { "kind": "json", "into": "data" } }
  ],
  "errorCases": [{ "code": "SITE_CHANGED", "when": "an assertion about the page failed; the site may have changed" }],
  "evidence": [{ "artifactType": "ApiCandidates", "refId": "api-3f9c…", "note": "search request observed during the search probe" }]
}
```

Validation replays every tool against the live site with its example inputs and requires five checks to pass: runs succeed, output matches the schema, output is non-empty, results are stable across runs, latency is within the tool's timeout. On a 60,000-URL car marketplace this produced 25 tools, 11 of them pure HTTP, 24 validated; listings answer in under a second where the browser fallback takes three to five ([docs/comparisons/syarah.md](docs/comparisons/syarah.md)).

## Quick start

Requires Node 20+ and pnpm. Browser stages need Chromium.

```bash
pnpm install
pnpm exec playwright install chromium --only-shell
pnpm build
node dist/cli.js discover https://example.com --max-pages 30
```

Then review, publish and serve:

```bash
node dist/cli.js tools <siteId>                   # tools with validation verdicts
node dist/cli.js publish <siteId>                 # publish every validated tool
node dist/cli.js call <siteId> search_products --input '{"query":"shoes"}'
node dist/cli.js serve <siteId>                   # MCP server over stdio
node dist/cli.js studio                           # local review UI at http://127.0.0.1:4848
```

MCP client configuration, for example in Claude Code:

```json
{ "mcpServers": { "webmorph-shop": { "command": "node", "args": ["/path/to/webmorph/dist/cli.js", "serve", "<siteId>", "--out", "/path/to/.webmorph"] } } }
```

Artifacts land under `.webmorph/sites/<siteId>/jobs/<jobId>/artifacts/`. Add `--json` to `discover` for a machine-readable summary and `-v` to log every fetched page.

## Serving tools to agents

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/runtime.dark.svg">
  <img alt="The agent call path: MCP server, executor, interpreter, HTTP client or browser runtime" src="docs/diagrams/runtime.svg">
</picture>

Only published, read-only, session-free tools run. Calls are bounded by a per-site concurrency limit and the tool's timeout. After two consecutive failures that implicate the site rather than the caller, a tool is degraded and refused until an operator revalidates it, so agents never retry blindly against a changed site. Results come back as `structuredContent`; failures carry one of the typed error codes (`INPUT_INVALID`, `OUT_OF_SCOPE`, `LOCATOR_MISSING`, `NOT_FOUND`, `SITE_CHANGED`, `OUTPUT_INVALID`, `BLOCKED`, `TIMEOUT`, `RUNTIME_ERROR`, `PERMISSION_DENIED`).

## Safety model

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/safety.dark.svg">
  <img alt="Network safety: the same policy on the HTTP client and the browser, enforced at the connection and at the request" src="docs/diagrams/safety.svg">
</picture>

- **Scope is exact hostnames.** Redirects and links to other hosts are recorded and never followed.
- **SSRF defense in depth.** Blocked hostnames, private and reserved IPv4 and IPv6 ranges (including mapped and NAT64 forms), DNS resolve-and-check before the first request, a pinned lookup so the address that was checked is the one dialed, and every redirect hop re-checked. The browser gets the same policy twice: a local policy proxy per connection and a route layer per request.
- **Read-only by construction.** Probes and tools never send a write without an explicit operator flag, and even then only search or filter forms without sensitive fields. Consequential controls (buy, delete, sign in, subscribe, accept cookies) are inventoried, never activated.
- **Bot protection is detected, never evaded.** Challenge and rate-limit pages are marked `blocked`.
- **Evidence is redacted at capture.** Sensitive query values replaced, request bodies never stored, cookie and credential headers recorded by name only.
- **Credentials are never captured.** A keyed public API becomes an HTTP tool only when the operator configures the key for that host and header; the value lives in one owner-only file and is resolved by name at run time. See [docs/architecture.md#keyed-public-apis](docs/architecture.md#keyed-public-apis) and decision D23.
- **Polite by default.** Identifying User-Agent, per-host delay, robots.txt honored, `Retry-After` respected.
- **The model never decides mechanics.** Optional Claude enrichment adds descriptions and cited hypotheses through schema-constrained output; ungrounded output is rejected and listed. Page content reaches the model only as data.

## CLI

| Command | Purpose |
|---|---|
| `discover <url>` | Run the pipeline. Budgets: `--max-pages`, `--max-depth`, `--delay-ms`, `--concurrency`, `--inspect-pages`, `--max-probes`, `--validation-runs`. Scope: `--allow-host`, `--ignore-robots` (sites you own), `--allow-private` (test fixtures). Stages: `--no-browser`, `--no-interactions`, `--no-model`, `--no-validate`, `--resume <jobId>`. Credentials: `--api-credential '[name@]host:header=value'`, `--api-credentials-file <json>`. |
| `tools <siteId>` | Generated tools with validation verdict and registry status. |
| `publish <siteId> [names...]` | Approve validated tools into the per-site registry (`--force` for unvalidated, `--job` to choose a job). |
| `call <siteId> <name> --input <json>` | Call a published tool through the executor. |
| `run-tool <siteId> <name> --input <json>` | Run any generated tool from a job, published or not. |
| `disable`, `enable`, `revalidate` | Lifecycle of published tools. |
| `serve <siteId>` | MCP server over stdio. |
| `credentials list\|set\|remove <siteId>` | Operator-configured credentials for keyed public APIs. Never prints values. |
| `record <siteOrUrl>`, `recordings <siteId>` | Record a workflow by hand in a browser WebMorph owns; list recordings. |
| `studio` | Local review UI over the artifact store. |
| `schemas export [dir]` | JSON Schema for every artifact type. |

## Artifacts

| Artifact | Stage | Contents |
|---|---|---|
| `SiteManifest` | 0 | Normalized start URL, allowed hosts, budgets, prohibited actions, resolved addresses, credential references |
| `DocumentationIndex` | 1 | `llms.txt`, OpenAPI and Swagger operations with parameters, auth and side-effect class, documentation pages |
| `URLInventory` | 2 | robots.txt verdicts, sitemap tree, every discovered URL with its sources, route candidates |
| `PageInventory`, `PageTemplates`, `CrawlReport` | 3 | Per-page facts, pages grouped into classified templates, budgets and bot-protection signals |
| `InspectionPlan` | 4 | Which pages get a browser session and why |
| `PageModel`, `ElementInventory` | 5 | Rendered page state, dialogs, screenshots; interactive elements with ranked locators |
| `InteractionEvidence`, `StateTransition` | 6 | Probes with before and after state; navigations and in-page changes |
| `NetworkEvidence`, `ApiCandidates` | 7 | Redacted traffic; observed endpoints matched against documentation |
| `WebsiteModel` | 8 | Page types, entities, capabilities with mechanics; facts citing evidence, hypotheses citing facts |
| `WorkflowDefinition` | 9 | Recorded sessions as replayable steps |
| `ToolDefinition`, `ValidationReport` | 10 | Tools as declarative programs with `apiGaps`; replay verdicts and reasons |

Every artifact carries a common envelope (schema version, site and job IDs, producing stage, source artifacts, provenance) and every type is a Zod schema exportable to JSON Schema.

## Documentation

- [docs/architecture.md](docs/architecture.md): stages, tool generation, safety, runtime, store layout.
- [docs/decisions.md](docs/decisions.md): twenty-five numbered architecture decisions and the reasons behind them.
- [docs/roadmap.md](docs/roadmap.md): the seven delivered phases with their acceptance criteria and known gaps.
- [docs/comparisons/](docs/comparisons/): evaluations against live sites, such as a 60,000-URL bilingual car marketplace.
- [plan.md](plan.md) and [plan-review.md](plan-review.md): the original product plan and its review.
- Diagrams: Excalidraw sources under [docs/diagrams/](docs/diagrams/), generated from [scripts/diagrams/scenes.mjs](scripts/diagrams/scenes.mjs) with `pnpm diagrams`.

## Development

```bash
pnpm test          # unit tests plus end-to-end runs against a local fixture site
pnpm typecheck
pnpm build
pnpm diagrams      # regenerate docs/diagrams/* with Excalidraw's exporter in headless Chromium
```

The fixture site in `test/fixtures/server.ts` exercises sitemaps (index, gzip, text), robots rules, redirect loops, out-of-scope and private redirects, oversized and gzip-bomb responses, retryable errors, SPA shells, bot challenges, GraphQL queries and mutations, a keyed JSON API, embedded page JSON, and a mix of page templates. Every safety property has a test that tries to violate it.

```
src/
  schemas/    Zod artifact contracts (source of truth, exported to JSON Schema)
  core/       artifact store, job runner, IDs, errors
  net/        URL normalization, SSRF guard, scope policy, rate limiting, safe HTTP client, redaction
  html/       HTML fact extraction, render-mode probe, templates, bot-block detection, page data
  browser/    Playwright runtime behind the policy proxy, inspection, probes, locators
  docs/       llms.txt and OpenAPI parsing
  model/      deterministic website model, naming, Claude enrichment
  tools/      tool generation, sampling, the interpreter
  stages/     stage0-scope … stage10-validate
  registry/   published-tool registry
  adapter/    executor and MCP server
  record/     recorder and in-page instrumentation
  studio/     local review UI
test/         vitest suites and the fixture site
docs/         architecture, decisions, roadmap, comparisons, diagrams
scripts/      diagram generator
```

## Status

All seven planned phases are implemented and tested against the fixture site and live sites. What remains before a first release is measurement rather than features: a benchmark harness over a fixed site set, typed response schemas for JSON API tools, and scheduled revalidation to report replay stability over time. See [docs/roadmap.md](docs/roadmap.md).

## License

[MIT](LICENSE).
