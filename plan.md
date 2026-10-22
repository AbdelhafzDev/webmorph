# WebMorph — Full Product & Technical Implementation Plan

**Product:** WebMorph
**Vision:** Transform any authorized website into a structured, inspectable set of capabilities that AI agents can use through tools and reusable skills.

## 1. Product vision

WebMorph accepts a website URL, discovers what the website offers, analyzes its structure, optionally records a real user's interactions, and generates validated tools and skills that an AI agent can use.

WebMorph is not simply a web crawler, a browser recorder, or an autonomous browser agent. It is a website discovery and capability-generation platform.

The core workflow is:

1. Submit a website URL.
2. Discover public documentation and API references.
3. Find sitemap files and discover pages.
4. Crawl accessible HTML and build a website map.
5. Inspect important pages using the browser DOM and accessibility tree.
6. Explore selected interactions when static analysis is insufficient.
7. Optionally record a user demonstrating a workflow.
8. Generate website-specific tools and reusable skills.
9. Validate generated capabilities against the actual website.
10. Publish approved capabilities to an agent through MCP or a native integration.

### Core principles

* Deterministic discovery before LLM-based analysis.
* Public documentation before browser exploration.
* Sitemap discovery before broad crawling.
* HTML analysis before JavaScript browser inspection.
* Targeted interactions instead of exhaustive exploration.
* Evidence-backed outputs rather than unsupported model guesses.
* Reuse discovered evidence across stages.
* Explicit approval for sensitive or consequential actions.
* Small, independently testable components.
* No custom workflow engine until a demonstrated need exists.

## 2. Product scope

### In scope for the initial product

* URL-based website analysis.
* Public documentation discovery.
* Sitemap and robots.txt discovery.
* Same-origin URL crawling.
* Page inventory and website mapping.
* DOM and accessibility inspection.
* Candidate action discovery.
* User session recording in a controlled browser.
* Workflow reconstruction from recorded sessions.
* Tool and skill generation.
* Replay-based validation.
* MCP integration.
* Versioned artifacts and capability publishing.

### Out of scope for the first release

* Exhaustively exploring every possible UI state.
* Automatically bypassing authentication, CAPTCHAs, paywalls or access controls.
* Automatically executing purchases or bookings.
* Generating unrestricted executable code from LLM output.
* Building a general-purpose browser agent framework.
* Supporting every native mobile application.
* Replacing existing official APIs with browser automation when an API is available and appropriate.

## 3. System architecture

The initial architecture should be a modular application, not a collection of independent microservices.

### Main components

#### WebMorph Studio

* Submit URLs and configure analysis.
* View discovered pages and analysis evidence.
* Inspect recordings and workflow timelines.
* Review candidate tools and skills.
* Approve, publish or disable capabilities.

#### Control Plane API

* Manage websites, analysis jobs, sessions and artifacts.
* Track stage status and retries.
* Apply scope and permission policies.
* Store versions and approval decisions.

#### Discovery Engine

* Run deterministic discovery stages.
* Collect and normalize evidence.
* Decide whether further analysis is necessary.
* Produce a structured website model.

#### Browser Runtime

* Execute browser inspection and interactions.
* Record user actions.
* Capture DOM snapshots, screenshots and browser events.
* Replay workflows and verify outcomes.

#### Capability Builder

* Convert evidence into candidate tools.
* Compose tools into reusable skills.
* Generate input/output schemas and tests.
* Track the evidence behind every generated capability.

#### Validation Engine

* Execute tests in an isolated browser.
* Check expected outcomes and locator stability.
* Detect regressions and website changes.
* Prevent unvalidated capabilities from being published.

#### Agent Adapter

* Expose approved capabilities through MCP or a native API.
* Provide typed schemas and execution results.
* Enforce permissions and action policies at runtime.

### Logical architecture

URL submission → Control Plane → Discovery Engine → Website Model → Capability Builder → Validation Engine → Approved Tools and Skills → Agent Adapter.

The Browser Runtime is shared by discovery, recording, and validation. It should not be tightly coupled to the capability-generation logic.

## 4. Discovery Engine: canonical pipeline

The Discovery Engine should use a fixed, understandable sequence of stages. Each stage produces a persisted artifact and can be retried independently.

### Stage 0 — URL validation and scope

Input:

* Starting URL.
* Optional allowed domains.
* Crawl depth and page limits.
* Optional authentication/session configuration.

Responsibilities:

* Normalize the URL.
* Validate the scheme and hostname.
* Restrict redirects and discovered links to approved origins.
* Block localhost, private-network and cloud metadata endpoints unless explicitly authorized under a safe, controlled configuration.
* Establish timeouts, concurrency limits and request budgets.
* Define prohibited actions and domains.

Output:

* `site-manifest.json`

The manifest identifies the starting URL, normalized origin, allowed scope, configuration and analysis version.

Failure behavior:

* Reject invalid or unsafe targets before any crawling begins.

### Stage 1 — Public documentation discovery

Look for documentation before exploring the website interactively.

Discovery candidates include:

* `/llms.txt`
* `/llms-full.txt`
* `/openapi.json`
* `/swagger.json`
* `/api-docs`
* `/docs`
* `/developer`
* `/developers`
* `/reference`
* `/api`
* Public documentation links found on the homepage.

These are optional conventions and candidate locations, not guaranteed endpoints. Also inspect page links, HTML metadata and linked documentation indexes.

Responsibilities:

* Fetch candidate resources using bounded requests.
* Detect the content type.
* Parse Markdown, HTML and recognized API specifications.
* Follow documentation links within the approved scope.
* Record the source URL and retrieval status.
* Extract documented operations, schemas, authentication requirements and usage examples when available.

Output:

* `documentation-index.json`
* Stored documentation artifacts.

Do not treat undocumented endpoints inferred from website behavior as official API contracts.

Failure behavior:

* Continue when documentation is absent, inaccessible or invalid.

### Stage 2 — Sitemap and URL discovery

Check `/robots.txt` and extract any declared sitemap locations.

Then try conventional sitemap locations such as:

* `/sitemap.xml`
* `/sitemap_index.xml`

Follow sitemap indexes with limits on the number of files, URLs, response size and recursion depth.

If no sitemap is found, continue with same-origin links from the homepage and discovered pages.

Responsibilities:

* Parse sitemap XML.
* Extract canonical candidate URLs and useful metadata.
* Normalize trailing slashes, URL fragments and query parameters.
* Deduplicate URLs.
* Reject out-of-scope destinations.
* Track the source of every discovered URL.
* Respect applicable crawling policies and access restrictions.

Output:

* `url-inventory.json`
* `route-candidates.json`

A sitemap is a discovery hint, not proof that a page exists or is accessible.

Failure behavior:

* Fall back to link crawling without failing the analysis.

### Stage 3 — Static HTML crawling

Fetch the discovered pages using a controlled HTTP client before launching a browser for every page.

For each successful response, collect:

* Final URL and redirect chain.
* HTTP status and content type.
* Page title and metadata.
* Headings and important text.
* Canonical URL.
* Internal links and their anchor text.
* Forms, labels and input types.
* Basic page structure.
* Links to scripts, stylesheets and other potentially useful resources.

Identify likely page templates, such as product details, search results, category listings, account pages and documentation pages.

Group URLs that appear to share the same template. This avoids inspecting hundreds of near-identical pages.

Output:

* `page-inventory.json`
* `page-templates.json`
* `crawl-report.json`

Failure behavior:

* Record inaccessible pages and continue with other candidates.
* Use bounded retries for transient failures.
* Do not retry permanent errors indefinitely.

### Stage 4 — Prioritize pages for browser inspection

Not every URL needs a full browser session.

Prioritize:

1. Homepage and primary navigation.
2. Important landing pages.
3. Search and listing pages.
4. Representative detail pages.
5. Forms and interactive pages.
6. Authenticated pages when an authorized session is available.
7. Pages with evidence of JavaScript rendering or important interactions.

Choose representative pages for repeated templates and expand coverage only when evidence indicates meaningful differences.

Output:

* `inspection-plan.json`

The plan records which pages need browser inspection and why.

### Stage 5 — DOM and accessibility inspection

Use Playwright to load selected pages in an isolated browser context.

Collect:

* Rendered URL and page title.
* Accessibility tree or supported accessibility snapshot.
* Relevant DOM structure.
* Links, buttons, forms and input controls.
* Accessible roles and names.
* Stable identifiers such as test IDs.
* Locator candidates.
* Relevant dialogs, menus and visible page regions.
* Screenshot references.
* Console errors and navigation failures where useful.

Do not rely exclusively on CSS selectors or screenshot coordinates. Prefer semantic locators and stable identifiers, then use CSS or visual interaction as fallbacks.

Classify discovered elements by potential role:

* Navigation.
* Search.
* Filtering.
* Selection.
* Form submission.
* Data display.
* Authentication.
* Potentially consequential action.

At this stage, identify candidate actions without assuming they work.

Output:

* `page-model.json`
* `element-inventory.json`
* `dom-snapshots/`
* `screenshots/`

### Stage 6 — Targeted interaction discovery

Only explore interactions that matter and remain uncertain after static analysis.

Examples:

* Open a navigation menu.
* Expand an accordion.
* Change a filter.
* Perform a harmless search.
* Navigate through pagination.
* Submit a non-destructive form.
* Inspect a modal or dropdown.
* Change tabs and observe the resulting state.

For each interaction:

1. Capture the initial state.
2. Execute one bounded action.
3. Wait for a meaningful condition.
4. Capture the resulting state.
5. Compare relevant DOM and URL changes.
6. Record errors or unexpected outcomes.
7. Restore the original state when possible.

Use explicit action budgets and state-based waits instead of arbitrary long sleeps.

Never assume that a button click succeeded merely because no exception was thrown.

Output:

* `interaction-evidence.jsonl`
* `state-transitions.json`

If the site requires authentication, use an explicitly authorized browser session. Do not attempt to bypass authentication or other access controls.

### Stage 7 — Optional network analysis

Use network evidence when it helps explain a feature or when an authorized API integration is preferable to browser automation.

Capture only relevant, permitted requests and responses.

Possible discoveries:

* Search endpoints.
* Pagination patterns.
* Read-only data operations.
* Public API schemas.
* Data required by a particular UI action.

Redact cookies, authorization headers, tokens, passwords and sensitive response fields.

Do not replay private requests outside the user's authorization or infer permission to call internal endpoints simply because they are visible in browser traffic.

Output:

* `network-evidence.jsonl`
* `api-candidates.json`

Network analysis is optional. It should not block the main discovery pipeline.

### Stage 8 — Semantic website model

Combine documentation, URL inventories, HTML, DOM observations and interaction evidence.

Build a structured model describing:

* Website purpose.
* Page types and route relationships.
* Core entities.
* Search and navigation capabilities.
* Forms and required inputs.
* Candidate actions.
* Preconditions and expected outcomes.
* Authentication dependencies.
* Evidence sources and confidence.
* Unresolved questions.

Keep observed facts separate from inferred hypotheses.

For example:

Observed:

* A search form contains a location field.
* Submitting the form navigates to a results URL.
* The resulting page displays a list of restaurants.

Inferred:

* The form may support restaurant discovery by location.

The inferred capability should not be considered validated until the behavior and outputs are verified.

Output:

* `website-model.json`

### Stage 9 — Workflow reconstruction

Combine related actions into candidate user workflows.

Examples:

* Search for a restaurant.
* Compare product options.
* Find a travel itinerary.
* Update an account preference.
* Navigate a SaaS dashboard.

A workflow definition should include:

* Intent.
* Required inputs.
* Ordered steps.
* Preconditions.
* Expected outcomes.
* Branches and failure paths.
* Retry conditions.
* Required user approvals.
* Evidence references.

Use recorded user demonstrations as additional evidence. When a demonstration is available, it should help establish a realistic sequence of actions rather than force the system to infer the whole workflow from static pages.

Output:

* `workflow-candidates.json`

### Stage 10 — Validation and capability generation

Generate candidate tools and skills from the website model and workflow evidence.

Validate:

* Input and output schemas.
* Locator stability.
* Preconditions.
* Expected state transitions.
* Replay success.
* Error handling.
* Permissions and side-effect classifications.
* Behavior when the website changes.

Only publish capabilities that meet their defined acceptance criteria.

Output:

* Versioned tool definitions.
* Versioned skill definitions.
* Regression tests.
* Validation reports.
* Approval records.

## 5. Adaptive discovery without unnecessary complexity

The stages above form the default pipeline, but not every website needs every stage.

Use a small set of explicit rules:

* If public documentation describes a capability, record it before attempting to infer the same capability from the UI.
* If a sitemap exists, use it to seed the URL inventory.
* If a sitemap does not exist, use same-origin link crawling.
* If a page is static and adequately understood, do not launch further interactive exploration.
* If JavaScript hides important content, inspect the rendered DOM.
* If an important action is still unclear, run targeted interaction discovery.
* If the action requires an authenticated session, mark the capability as session-dependent.
* If a workflow cannot be validated safely, keep it as a candidate rather than publishing it as a verified capability.

An exploration planner can implement these rules. It should select the next action based on missing evidence, importance, cost and risk.

It does not need to be a separate LLM agent. Start with deterministic rules and introduce model-assisted prioritization only if measurements demonstrate a benefit.

## 6. Session recording

WebMorph should support two distinct recording modes.

### Mode A — Controlled browser

WebMorph launches a browser session that it owns.

The user performs a workflow while WebMorph records:

* Navigation.
* Clicks.
* Input interactions, excluding sensitive values.
* Selection changes.
* Form submissions.
* Relevant before-and-after states.
* Optional screenshots and traces.

This is the recommended initial implementation because the browser runtime controls the page and can collect structured evidence.

### Mode B — Existing authenticated browser

A browser extension or explicit browser integration captures interactions in an existing user session.

This mode is useful when the workflow depends on an existing login. It requires a separate permission model, session isolation and careful handling of cookies and authentication data.

Do not assume that an in-app WebView automatically inherits Chrome or Safari cookies. For an iOS application, an app-owned WKWebView should be treated as its own session; authenticate within that WebView when required.

### Recording event format

Each event should include:

* Session ID.
* Sequence number and timestamp.
* Page URL.
* Action type.
* Semantic target.
* Relevant input metadata, with sensitive values redacted.
* Before-state reference.
* After-state reference.
* Screenshot or DOM artifact references.
* Result status.
* Error details, if any.

Store the event log separately from generated workflow definitions. This allows workflows to be reconstructed again without repeating the recording.

### Recording output

A recorded session produces:

* An ordered action timeline.
* State-transition evidence.
* Candidate workflow steps.
* Reusable action patterns.
* A replay test.

The system must distinguish the user's observed actions from the intent inferred by the model.

## 7. Website model and artifact contracts

Use versioned JSON artifacts initially. Avoid introducing a graph database or complex schema registry until needed.

Recommended artifact types:

* `SiteManifest`
* `DocumentationIndex`
* `URLInventory`
* `PageInventory`
* `PageModel`
* `ElementInventory`
* `InteractionEvidence`
* `StateTransition`
* `WebsiteModel`
* `WorkflowDefinition`
* `ToolDefinition`
* `SkillDefinition`
* `ValidationReport`

Every derived artifact should contain:

* Schema version.
* Website or project ID.
* Discovery job ID.
* Creation timestamp.
* Source artifact references.
* Processing stage.
* Evidence provenance.

Artifacts should be immutable per version. A new discovery run creates new versions instead of silently overwriting evidence used by existing capabilities.

## 8. Tool and skill generation

WebMorph should produce three layers of capabilities.

### Layer 1 — Browser primitives

Generic browser operations:

* Navigate to a URL.
* Read page state.
* Locate an element.
* Click a target.
* Fill an input.
* Select an option.
* Scroll to a region.
* Wait for a specific state.

These are implemented by the browser runtime, not regenerated for every website.

### Layer 2 — Website-specific tools

Typed actions discovered from the website.

Examples:

* `search_restaurants(query, location)`
* `get_product_details(product_id)`
* `filter_results(criteria)`
* `get_account_settings()`

Every tool should define:

* Input schema.
* Output schema.
* Preconditions.
* Execution strategy.
* Expected result.
* Error cases.
* Permission requirements.
* Evidence references.
* Validation status.

Prefer official documented APIs when they are available, appropriate and authorized. Otherwise,

<!-- NOTE: The source text ended here, mid-sentence, in section 8 (Layer 2). Layer 3 (skills) and any later sections (validation details, security model, data model, tech stack, milestones, open questions) were not included in the pasted plan. -->
