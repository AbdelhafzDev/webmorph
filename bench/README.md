# Benchmark

A fixed set of live sites, each discovered several times with one budget, scored from the artifacts. It answers the
question a single live run cannot: does a change help connectors in general, or only the site it was tuned on, and
what does it cost in tokens and time.

## Run it

```bash
pnpm bench --label 2026-11-01
```

Options: `--sites sar,haraj` (default: every site in `sites.json`), `--runs 2`, `--parallel 2` (sites run side by
side; runs of one site go one after another, so a site sees one crawler at a time), `--store` (raw artifacts, default
`.webmorph-bench/`, ignored by git), `--config` (another site list), `--verbose`. Provider keys come from `.env`.

Compare two labels with `pnpm bench:compare <before> <after>`: a table of per-site means and deltas.

The outputs are `results/<label>.json` (one scorecard per run) and `results/<label>.md` (the table). Commit both: the
baseline is what a later run is compared against.

## What a scorecard measures

| Field | Meaning |
|---|---|
| Tools validated (HTTP / browser) | Tools whose replay passed every validation check, split by transport. HTTP tools are the deliverable (decision D25). |
| Main task | Whether a validated tool covers what a visitor comes to the site for, as `mainTask` in `sites.json` defines it: a name, title or description matching `match`, and an input for every entry of `inputs` (each a set of name patterns). An HTTP tool is preferred over a browser one when both qualify. |
| Required inputs | What a caller must pass to that tool. Fewer is better when the rest default to browsed values. |
| Main task fields (filled) | Named fields in that tool's result rows on replay, and the share of cells that hold a value. One field is a text blob an agent must parse again. |
| Structured tools | Validated tools whose rows carry two or more named fields, over the validated tools that returned rows. |
| Agent turns, tokens, cache reads | The stage 8 harness's loop: turns taken, uncached input plus output tokens, prompt-cache reads apart (they cost about a tenth). |
| Wall | Seconds for the whole job, crawl to skill. |
| Per-site notes | Proposals kept and rejected, why the loop stopped, tools that failed validation, API gaps by reason. |

A run is not a pass or a fail; the table is read as deltas against the previous label, site by site. Variance between
runs of the same site is itself a result: a change that makes the main task covered in two of two runs instead of one
of two is a real improvement.

## The sites

| Site | Why it is in the set | Main task |
|---|---|---|
| `sar` | Content site plus a client-rendered booking app on a second host whose form sits in an iframe and whose API is opaque: the browser route must carry it | Search train trips between two stations on a date |
| `syarah` | Large server-rendered marketplace behind Cloudflare, rich JSON-LD and embedded state, keyed search API | Search cars by keyword or make |
| `haraj` | Classifieds site with its own GraphQL search the front end calls; HTTP tools should carry it | Search posts by keyword |

Add a site by appending to `sites.json` with its budget overrides and `mainTask`. Keep the set small enough to run
after a change; a benchmark nobody runs measures nothing.
