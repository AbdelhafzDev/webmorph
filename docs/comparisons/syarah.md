# Syarah: WebMorph on a large bilingual car marketplace

Evaluation of WebMorph against [syarah.com](https://syarah.com/), Saudi Arabia's online car retailer, run on 2026-10-21 with the same budget used for Haraj: 30 static pages, 8 browser pages, 8 probes, one validation run per tool, no model enrichment (`--max-pages 30 --max-depth 2 --delay-ms 800 --inspect-pages 8 --max-probes 8 --validation-runs 1 --no-model`). Five runs, each after fixing what the previous one exposed. Each run takes about six minutes.

## What the site is

Syarah is a server-rendered site (no client-side shell) behind Cloudflare, Arabic by default at `/` and English under `/en/`. It is large and well described:

- `robots.txt` declares three sitemap indexes (English, Arabic, and a WordPress "carsguide" blog) and disallows `/api/`, `/*post/*`, `/*user/*`, `/*car-finance/*`, `/*online/*`, `/*dealer/*` and a few more.
- Each locale's index has twelve child sitemaps: makes (119 URLs), make and model (2,043), make, model and year (22,473), car detail pages (3,472), cities (68), static pages (19), trending searches (111), years (960), financing by make (314), prices (1,814), car countries (15) and products (2). About 31,000 URLs per locale.
- `/llms.txt` exists and lists 62 links in sections: core services (used cars, new cars, sell or trade, financing, calculator, comparison, order tracking, showrooms, service centers, engine oils), 39 brands, content pages and legal pages. There is no `llms-full.txt` and no OpenAPI document (`/openapi.json` answers 403).
- Car pages publish schema.org JSON-LD: a `Car` with `Offer` (price, currency, availability), `Brand`, model, trim, model year, mileage, colours, drive configuration, `EngineSpecification`, doors and seats, plus a `BreadcrumbList` and a `LocalBusiness`. Brand pages publish an `ItemList`, `Product` entries, an `FAQPage` and breadcrumbs. Every page also embeds a `FULL_PAGE_DATA` JSON object; on a car page it holds `postDetails` (details, price, options, story, quality, meta, gallery, fuel, faqs) and `similarPosts`.
- The front end calls two of its own APIs. `search-api.syarah.com/api/v1/{lang}/index?filters[text]=…&page&size` serves search and listings, with `/autosuggest?q` and `/recommended` beside it; every call carries `Authorization: Bearer pk_search_live_…`, a publishable key shipped in the JavaScript bundle, and answers 401 without it. `syarah.com/api/syarah_v1/{lang}/post/view-online?id=…` serves car details and requires a per-visitor `token` header (401 without it); `cart/get-cart`, `site/check-working-time` and a `POST search/track` analytics call sit next to it. Third-party traffic (GrowthBook feature flags, Google ads, Clarity, New Relic, an OpenAI pixel) outnumbers the site's own.

## What WebMorph produced

The final run (job `20261021T075034Z-8509f31a`) produced sixteen tools, all validated by replay against the live site. Live calls afterwards:

| Tool | Transport | Inputs | Validation | Live call |
|---|---|---|---|---|
| `search_cars_en` | browser, `/en/filters?text=` | `query` | validated, 4.1 s | "camry": 16 Camry listings with titles and URLs, 4.9 s |
| `search_cars` | browser, `/filters?text=` (Arabic) | `query` | validated, 4.5 s | 15 results for the probe's query |
| `list_cars_by_autos_en` | browser, `/en/autos/{{auto}}` | `auto` (make) | validated | "toyota": 16 cars, 4.7 s |
| `list_cars_by_autos` | browser, `/autos/{{auto}}` (Arabic) | `auto` | validated | "toyota": 16 cars |
| `list_cars_by_city` | browser, `/city/{{city}}` | `city` | validated | "riyadh": 16 cars, 3.4 s |
| `list_cars_by_trend` | browser, `/en/trend/{{trend}}` | `trend` | validated | 20 cars for a trending search page |
| `list_cars_by_years` | browser, `/en/years/{{year}}` | `year` | validated | "2020": 12 cars |
| `list_cars_by_years_2` | browser, `/en/years/{{year}}/{{slug2}}` | `year`, `slug2` (make) | validated | 20 cars |
| `list_cars_by_financing` | browser, `/en/financing/{{financing}}` | `financing` | validated | 8 cars |
| `list_cars_by_prices` | browser, `/en/prices/{{price}}` | `price` (make) | validated | 8 cars |
| `get_car_en_api` | HTTP, the car page's structured data | `slug` | validated, 0.4 s | Camry 320264: price 59,500 SAR, in stock, used, Toyota Camry GLE 2020, 339,255 km, white with beige interior, front-wheel drive, 4 doors, 5 seats, 35 images, breadcrumbs Home › Autos › Toyota › Camry, plus the embedded `postDetails` and 4 similar posts; 0.6 s |
| `get_car_api` | HTTP, Arabic car page | `slug` | validated, 0.4 s | same fields in Arabic |
| `get_car_en`, `get_car` | browser | `slug` | validated | title, heading and text of a car page |
| `get_oil_api`, `get_oil` | HTTP and browser, `/en/products/oil/{{slug}}` | `slug` | validated | an engine-oil product page |

Evidence behind them: 5,001 URLs admitted from 20 sitemap files, 30 static pages grouped into 27 templates (19 of them inspected in the browser through representatives), 8 browser pages with 1,299 elements (1,081 uniquely locatable), 7 probes, 425 captured requests grouped into 17 API candidates, 56 facts and 17 hypotheses. The site's two entities came out as `car` (from `/cardetail/{slug}`) and `oil`.

Compared with Haraj, the balance is reversed. Haraj exposed a public GraphQL search, so its best tool was an API; its detail pages carried thin structured data. Syarah gates its search API behind a key, so search stays in the browser; its car pages carry everything a buyer would ask for, so the HTTP detail tool is the strong one, at well under a second.

## What it could not do, and why

- **No API search tool.** Every search-API call carries a bearer token. It is a publishable key, the same for every visitor, but WebMorph's policy is to never replay a credential it observed, whatever its prefix. The browser tool covers search end to end. If Syarah permits it, a configured credential supplied by the operator turns the same observed request into an HTTP tool: `--api-credential 'search-api.syarah.com:authorization=Bearer pk_search_live_…'` (decision D23, added after these runs and not yet exercised against the site). Discovery does not decide that on its own.
- **No API details tool beyond structured data.** The `view-online` endpoint needs a per-visitor token, and `robots.txt` disallows `/api/` anyway, so even an open endpoint there would be refused. The credential heuristic also missed this one (a header named `token` is not an authorization-style header), which validation would have caught had the endpoint been linked to a capability; the heuristic now has a known gap to close.
- **Make, model and year pages got no tool.** `/autos/{make}/{model}/{year}` was identified as a listing family, but the one member the sampler fetched (an Alfa Romeo 145 page) listed no cars, so there was no result shape to observe. Fetching a second member when the first is empty is the fix.
- **Embedded page data is returned raw.** `get_car_api` hands back `FULL_PAGE_DATA` under `embedded`, but the output schema does not describe its fields. Mining the embedded object's keys into the schema would make the richest data on the site addressable. (Closed since: the generator reads the representative page once and describes each embedded object's keys and kinds in the schema and description, two levels deep; see D24.)
- **Names are heuristic.** `car` is derived from `/cardetail/`, and path inputs are named after the segment before them (`auto`, `city`, `trend`, `year`, `slug2`). Model enrichment is where `make` and `model` would come from; it was off in these runs because no API key is configured.
- **Probe queries come from the page.** The search probes typed "cars", "السيارات" and a brand name found on the page. The generic Arabic word returned a "zero results" page with recommendations, which the probe correctly recorded as a navigation; validation used the probe's own query as the example.

## What this site taught WebMorph

Haraj's lessons were about transport (GraphQL, sibling hosts, cookies). Syarah's were about scale: a 30-page crawl of a 60,000-URL site has to be a sample, and the first run was not one.

1. **The sitemap budget filled from the first child sitemap.** Five thousand URLs came from makes, make-model and the start of make-model-year; the car detail sitemap, cities, trending and static pages never entered the inventory. URLs are now admitted round-robin across sitemap files.
2. **The crawl spent its budget on one section.** Homepage links and then sitemap seeds in alphabetical order gave 26 brand pages out of 30. The frontier now hands out pages by URL shape (depth plus leading section, with every top-level one-off page counted as one shape): no shape gets a third page before every shape has had two, and rank decides only among equals. `llms.txt` links are seeded ahead of homepage links. Run 2 showed the seeds alone could take the budget; run 3 showed the quota fixing that.
3. **Two crawled siblings could not form a template.** Generalizing `/autos/toyota` and `/autos/kia` into `/autos/{slug}` needed four siblings. The URL inventory now vouches for families: two crawled members collapse when the sitemaps list many siblings, including literal segments with children (`/autos/toyota/{id}` becomes `/autos/{slug}/{id}`). Run 4 showed the collapse swallowing top-level sections into `/en/{slug}/{slug}`; sections at the top level, with or without a locale prefix, are now never collapsed.
4. **Brand pages were entities.** `/en/autos/{slug}` ended in a placeholder, so it was a detail template and `get_auto("bmw")` returned a listing. A placeholder template whose pages declare an `ItemList`, or link eight or more times per page to one other identifier pattern, is a listing. Listings with path placeholders now become `list_<entity>_by_<section>` tools with path inputs, and the example input is the family member crawled pages link to most (run 3 shipped an obscure brand with no cars as the example).
5. **Search results were tied to the wrong pages.** The results page linked thirteen times to `/en/cardetail/…`, but the crawled brand template won because a few brand chips also matched it. Result links are now the landing page's links minus the links its form page already had, and the dominant new shape beats a crawled template that explains fewer of them. Run 4 found the ranking preferring any `{id}` pattern before counting: one stray `/channel/{id}` link outranked ten results.
6. **Small things.** `syarah_v1` in an API path became `{{slug}}` (version segments are literal now); the autosuggest endpoint was linked as the search API (suggestion paths are deprioritized); the Arabic search was `search_autos_2` (locale variants are named `search_cars` and `search_cars_en`); a detail example taken from a percent-encoded URL was encoded again and the server answered 500 (examples are decoded); and that 500 page passed validation because the site serves it with status 200 and a title (pages titled "Internal Server Error" or "Not found" now fail with `SITE_CHANGED` or `NOT_FOUND`).

Across the runs the tool count went 4 → 1 → 28 → 9 → 16 and the validated share 2/4 → 1/1 → 24/28 → 8/9 → 16/16. The suite grew from 168 to 187 tests; each fix above has a regression test on the fixture site or a unit test.

## Recommendations

- **For an agent that needs Syarah.** Publish `search_cars_en`, `list_cars_by_city`, `list_cars_by_autos_en` and `get_car_en_api`. Search and listing answer in 3 to 5 seconds with titles and URLs; a car's full record is one HTTP request away in under a second, with price, mileage, specification and images.
- **For WebMorph, from this site.** Operator-configured credentials for publishable keys, with the site's permission, so an observed keyed request can become an HTTP tool. Field discovery for embedded JSON (`FULL_PAGE_DATA.postDetails`). A second representative when a listing family's first member lists nothing. Treat a `token`-named request header as a credential. Run model enrichment for input names once a key is configured.
- **Ask Syarah.** `robots.txt` disallows `/api/` and the search API is keyed; everything above runs against infrastructure Syarah has not offered to third parties. The `llms.txt` is a signal they are thinking about agents; it would be the natural place for them to say what is allowed.

## Update: API first

After this evaluation the product direction was restated: HTTP tools are the deliverable and browser tools are the fallback (decision D25). Three changes followed, and a sixth run (job `20261021T091049Z-1cf30c2f`) shows their effect on this site.

- The HTTP route now carries the capability's name; the browser route is `_browser`.
- Listing and search pages that already contain their results are read over HTTP: the generator samples the landing page once, and when the results are in the HTML it emits an `html-list` tool that fetches the page and parses the links, with price, currency, availability and images from the page's schema.org `ItemList`.
- Capabilities with no HTTP route are reported as gaps with a reason.

Result: 25 tools, 11 of them HTTP, 24 validated. Every listing is an HTTP tool: `list_cars_by_city("riyadh")` returns 16 cars with price, currency, availability, image and description in 0.8 s, and `list_cars_by_autos_en("toyota")` 12 cars in 0.5 s, against 3 to 5 s for the browser fallbacks. Car and oil details stay HTTP. The two search capabilities are the reported gaps: `search-api.syarah.com` carries a publishable key, and the gap says so and names the command that would enable it with the site's permission (`webmorph credentials set`). One make-and-year page type renders its results client-side and keeps only a browser tool, which fails validation because its sampled example page lists no cars.
