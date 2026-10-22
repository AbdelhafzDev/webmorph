# Review of plan.md (WebMorph)

Reviewed 2026-10-20 against [plan.md](plan.md) as pasted. The source text is truncated in section 8, so Layer 3 (skills) and any later sections were not reviewable.

## Verdict

The plan is a strong architecture vision and a weak implementation plan. The principles are right, the stage decomposition is right, and the artifact-first approach is right. But it does not yet answer the questions that decide whether a first version ships: who the customer is, what the MVP slice is, how tools are represented and executed, where the browser runs, how untrusted web content is kept out of the LLM's instruction channel, and what "done" looks like.

Several genuinely hard problems are named in one bullet each as if they were routine: template clustering, structured output extraction, SPA handling, locator stability, safe-interaction classification, bot protection.

Recommendation: do not start implementation from this document. Resolve the six blocking decisions in section 1, add the missing sections listed in section 5, and cut the first release to a vertical slice.

## 1. Blocking decisions

### 1.1 Who is the customer, and what does "authorized" mean?

The vision says "any authorized website" but never defines authorization. Three different products hide here:

- **Site owner** publishing an agent interface for their own site. You can verify ownership (DNS TXT record or meta tag), ask for OpenAPI, sitemap and test accounts, and skip most of discovery.
- **Agent developer** targeting third-party public sites. Bot detection (Cloudflare, Akamai, PerimeterX), Terms of Service exposure, rate limiting and fragility dominate. The pipeline as written will be blocked at Stage 3 on many commercial sites.
- **Enterprise** targeting internal SaaS behind SSO. No sitemap, no public docs, an SPA shell, authenticated from the first page. Stages 1 to 3 contribute almost nothing; the product is browser-first plus recording.

The examples mix all three (restaurants, products, travel, "SaaS dashboard", "account settings"). Pick one for v1. It changes stage ordering, the authentication story, the hosting model and the legal posture.

### 1.2 Tools must be data, not code

Out of scope says "no unrestricted executable code from LLM output", and Layer 1 says primitives are implemented by the runtime. The plan never states the consequence: a Layer 2 tool is a **declarative step program** (navigate, fill, click, wait-for, extract) interpreted by the Browser Runtime, with an input schema, an output extraction spec and preconditions.

This is the single most important design decision for safety, validation, diffing and versioning. It should be a first-class section with a schema, not an implication.

### 1.3 Runtime execution model for the Agent Adapter

This is what customers actually use, and it is one bullet. It needs:

- Browser-per-call vs. pooled contexts, and session reuse for authenticated tools.
- Expected latency. Browser-backed tools take 3 to 30 seconds; agents time out.
- Concurrency limits per target site.
- How an authenticated session is provisioned and refreshed at call time, and where its secrets live.
- An error taxonomy the agent can act on: `INPUT_INVALID`, `PRECONDITION_FAILED`, `LOCATOR_MISSING`, `AUTH_REQUIRED`, `SITE_CHANGED`, `BLOCKED`.
- Who approves a consequential action at call time: the agent's end user, the WebMorph operator, or a standing policy.

### 1.4 Where does the browser run, and how does a user drive it?

Mode A says WebMorph launches a browser it owns and the user performs a workflow in it. If WebMorph is a server, the user needs a streamed remote browser in the Studio (CDP screencast or noVNC), which is significant infrastructure. If it is a desktop app or CLI, the control plane and Studio architecture change.

The plan never says whether WebMorph is SaaS, self-hosted or local. Decide this before designing Studio or the recorder.

### 1.5 Prompt injection and untrusted content

Stages 8 and 10 feed crawled page text, documentation and `llms.txt` into an LLM that produces the website model and tool definitions. A hostile or compromised site can inject instructions into that content. The plan has no mention of this.

Required:

- Treat all fetched content as data. Use structured extraction with schema-constrained output, not free-form prompts over raw page text.
- Never let page content set scope, permissions or side-effect class. Those come from the manifest and from human approval only.
- Keep the human approval gate mandatory for anything with side effects.
- Note that `llms.txt` and OpenAPI documents are site-controlled and must not override observed behavior.

### 1.6 MVP slice and success metrics

The in-scope list is the whole product: eleven stages, Studio, control plane, recorder, replay validation, MCP, versioning. No phases, no milestones, no metrics.

Define a benchmark set of 10 to 20 sites, including self-hosted fixtures, and target numbers for:

- Precision and recall of discovered capabilities against a hand-labeled ground truth.
- Tool replay success rate over 7 days.
- Median and p95 tool latency.
- Cost per site in LLM tokens and browser minutes.

Section 5 says model-assisted prioritization should be introduced "only if measurements demonstrate a benefit" but defines no measurements. Without them you cannot tell whether a stage is pulling its weight.

## 2. Design concerns by section

### Section 3: Architecture

- **Workflow engine contradiction.** "No custom workflow engine" conflicts with "each stage produces a persisted artifact and can be retried independently" plus stage status tracking in the Control Plane. That is a workflow engine. Either name an off-the-shelf one (Temporal, Inngest, BullMQ plus a job table) or acknowledge a minimal in-house one and bound it: one job table, one state machine, no DSL.
- **Browser Runtime serves four load profiles**: batch discovery, interactive recording, validation, and low-latency agent execution. These have different scaling and isolation needs. Share code; do not share deployment or capacity planning.
- **No tech stack.** Playwright implies Node or Python. Pick one. Pick storage (artifacts in an object store with a relational index), a queue, and the LLM provider, model and token budgets.

### Stage 0: Scope

- SSRF controls are listed for the HTTP client only. Browser navigation needs the same enforcement via Playwright request interception, including redirects re-checked per hop, DNS rebinding defense (resolve, check, pin), and IPv6 literals.
- Add an identifying User-Agent, politeness rate limits per host, and a robots.txt stance (respect by default, explicit owner-authorized override).

### Stages 2 and 3: URL discovery and static crawl

- The fallback "same-origin links from the homepage and discovered pages" means Stages 2 and 3 are a breadth-first loop, not sequential. Model it as one crawl with a frontier and keep the two artifacts.
- **SPA shells.** Static HTML of a React, Vue or Angular app yields near-zero text, no links, and defeats template grouping. Add an early render-mode probe (static text length vs. rendered text length on the homepage) that switches the site to browser-first. This is common, not an edge case.
- **Template detection is a research item.** "Identify likely page templates" is a clustering problem (URL path tokenization, DOM skeleton hashing, title patterns). Name the approach and track it as a risk.
- **Bot protection.** Expect 403, 429 and JavaScript challenges on commercial sites. Define behavior explicitly: stop, mark the site `BLOCKED`, never attempt evasion. Bypassing access controls is already out of scope; say what happens instead.

### Stage 5: DOM inspection

- The locator philosophy is right. Add how locators are ranked (test ID, then role plus accessible name, then label, then stable CSS, then text, then position) and how stability is measured (replay across N loads and across days).
- Decide the runtime policy when a locator fails. For v1: fail fast and flag the tool for re-validation. Do not self-heal.

### Stage 6: Interaction discovery

- "Restore the original state when possible" is unreliable. Use a fresh browser context per probe and re-navigate. It is cheap with Playwright and deterministic.
- "Submit a non-destructive form" needs a classifier and an allowlist. GET forms and forms whose action matches a known search or filter pattern are safe. Any POST, any form with email or phone fields, anything labeled submit, send, subscribe or contact is consequential until a human says otherwise. A contact form emails a real person.
- Add explicit interaction budgets per page and per site (action count and wall time) to the manifest.

### Stage 7: Network analysis

- "Redact sensitive response fields" needs a concrete policy: a header allowlist rather than a denylist, JSON key denylist patterns, and PII detection. Store redacted bodies only; never persist raw captures.
- State explicitly that `api-candidates.json` holds hypotheses for human review and is never auto-promoted to tools unless it matches Stage 1 public documentation.

### Stage 8: Website model

- The observed vs. inferred split is good. Add a confidence field with a defined scale and require every inferred statement to cite at least one observed evidence ID. Reject model output that does not.
- Define the LLM contract: schema-constrained structured output, a token budget per site, and caching keyed on artifact version.

### Stage 10: Validation

- **Output extraction is the hardest unaddressed piece.** Turning a results page into typed output for `search_restaurants` needs extraction specs (locator, field schema, list and pagination detection) and validation of extracted output against the output schema. It is currently absent.
- "Behavior when the website changes" needs an owner: scheduled re-validation, on-failure re-validation at call time, and a tool status lifecycle (draft, validated, published, degraded, disabled).

### Section 6: Recording

- Mode B (browser extension) is described but the in-scope list only includes controlled-browser recording. State clearly that Mode B is post-v1.
- Sensitive value detection: default to recording field semantics only (label, type, length) and never the typed value, with opt-in per field to keep values. Checking for `type=password` alone is not enough.
- The WKWebView and iOS paragraph is unrelated to anything else in the document. No iOS surface is described anywhere. Remove it or add the surface it refers to.

### Section 7: Artifacts

- Commit to publishing JSON Schemas for all thirteen artifact types as the first engineering deliverable. They are the contracts between components and the thing that lets people work in parallel.
- Add a dependency relation: a published tool pins the artifact versions it was validated against, so a new discovery run never silently changes a live tool.
- Add storage and retention. DOM snapshots and screenshots for hundreds of pages are gigabytes per site.

### Section 8: Tools

- Layer 3 (skills) is missing due to truncation. Also missing from the pasted text: validation detail, security model, data model, tech stack, milestones, open questions.
- The tool definition field list lacks `side_effect_class` (read, write, consequential), `idempotent`, `auth_requirement` (none, session) and `timeout`. These are what the runtime enforces permissions on.

## 3. Inconsistencies

| Where | Issue |
|---|---|
| Principles vs. Section 4 | "No custom workflow engine" vs. a stage pipeline with persisted state and independent retries |
| Scope vs. Section 6 | Mode B recording is described but is not in scope |
| Section 6 | iOS WKWebView guidance with no iOS surface described anywhere |
| Stage 2 vs. Stage 3 | Presented as sequential; actually a loop |
| Section 5 | "only if measurements demonstrate a benefit" with no measurements defined |
| Section 8 | Document ends mid-sentence |

## 4. What is solid

- Deterministic-before-LLM, documentation-before-browser, and evidence-backed outputs. These will keep cost and hallucination down.
- Per-stage persisted, immutable, versioned artifacts with provenance. This is the backbone; keep it.
- Observed vs. inferred separation in the website model.
- Template grouping to avoid inspecting hundreds of near-identical pages.
- Three-layer capability model (primitives, site tools, skills).
- Mandatory human approval before publishing, and an explicit out-of-scope list.
- Semantic locators first, CSS and visual as fallbacks.

## 5. Recommended next steps

1. Decide the v1 customer (1.1) and hosting model (1.4). Everything else depends on these two.
2. Write the tool definition schema as declarative step programs (1.2) and the runtime execution contract with error taxonomy (1.3).
3. Add a "Security and trust" section covering SSRF in both browser and HTTP client, prompt injection, secrets storage for authenticated sessions, and runtime permission enforcement.
4. Cut v1 to a vertical slice: one site type; Stages 0, 2, 3, 5, 8 and 10 only; no recording, no network analysis, no Studio beyond a review page; one read-only tool class (search, list, detail); MCP output. Add recording and consequential actions in v2.
5. Publish JSON Schemas for all artifacts before writing pipeline code.
6. Build three to five self-hosted fixture sites (static, SPA, sitemap-less, authenticated, bot-challenged) and a benchmark harness with the metrics in 1.6.
7. Restore the truncated sections: Layer 3 skills, validation detail, data model, tech stack, milestones, open questions.
