# 09 · Model History source health

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `scripts/model-history/check-sources.mjs` (874 lines), `.github/workflows/source-health.yml`, `model-history/state/source-status.json` (≈1 MB)

## What this layer does on its own

Once a day (03:41 UTC, or by hand) it requests the original URL and the archive copy (`archiveUrl`) of the curated sources and records what it observed per source in `state/source-status.json`. The generator turns that into "original online / archived / gone" labels and the evidence status. It never edits curated files and never deletes anything.

## How it decides

1. **Who is due** (`selectDue`): never-checked URLs first, then oldest `lastCheckedAt`; healthy URLs every **6 days**, a URL with a running streak of decisive failures every **3 days**; at most `RUN_LIMIT` = 300 sources per run. A `--budget-min` wall-clock budget (default 45 min) stops starting new work so the 60-minute job limit never discards a whole run.
2. **Politeness:** only public hosts (also for redirect targets), robots.txt respected (a disallow or an unreadable robots.txt → `blocked`), 5 s between requests to the same host, 4 hosts in parallel, 20 s timeout, ≤ 5 redirects, max 256 KB read per page, UA `AIRadarBot/1.0`. archive.org lookups: ≤ 100 per run, 2 s apart, circuit breaker after a 403/429.
3. **Classification** (first match wins): `ok`, `moved`, `blocked`, `error`, `gone`, `soft-404`. Challenge pages (Cloudflare etc.), parking pages and ordinary errors are *non-decisive*; only `ok`, `gone` (404/410/NXDOMAIN) and `soft-404` (error-like title/heading, canonical pointing to the site root, content far smaller than the first observation) are *decisive*. Anything unforeseen is `error`, so an unknown answer can never make a source unavailable.
4. **Hysteresis:** a source becomes `unavailable` only after **3 decisive failures in a row spanning ≥ 9 days**; a single `ok` makes it `active` again; `blocked`/`error`/`moved` change nothing. `stateSince` moves only on a transition. ≥ 90 days of only non-decisive results is reported as "unverifiable".
5. **Archive suggestions:** for a vanished source it looks up an Internet Archive capture (CDX API) and writes it as `archiveSuggestion`; a curator confirms it by checking the capture and recording `archiveUrl` in the source (T-07).
6. A `url`/`archiveUrl` replaced by the curator restarts that URL's bookkeeping.
7. The state is written **once, at the end**, atomically; a broken state file or sources file aborts the run without writing.

Output: the state file (for each source: state, counters, last result/HTTP status, fingerprint of the first good observation, archive check) and a report on stdout and in the (public) job summary.

## Workflow shape (`source-health.yml`)

`check` job (≤ 60 min, no write permission) → uploads `source-status.json` as an artifact → `publish` job (main only, ≤ 15 min, group `model-history-writer`): downloads it, validates, rebuilds `models/` and the sitemap, commits `source-status.json` (+ `models/`, `sitemap-models.xml` when the publish gate is on) as "Update model history source status". The whole run is serialised per branch (`source-health-<ref>`), because a newer run must build on the older run's counters. A dispatch on another branch checks and reports but publishes nothing.

## What other layers rely on

- `derive.mjs` reads the state (`effAvail`, `effProv`) to compute effective availability and evidence; the generator prints the labels.
- Hosts that block scripts stay `unknown` until a human checks them in a browser (T-16).
- The publish job shares `model-history-writer` with the build; GitHub keeps one pending run per group, so a waiting publish can be cancelled and that day's check is lost — start the workflow by hand to recover (T-09).

## Change checklist

- Timing constants are exported/commented in the header; changing the 3-failures/9-days rule or the intervals needs the matching tests (`check-sources.test.mjs`, 64 tests, fake fetch/sleep/clock — no test may touch the network).
- Anything that makes a source `unavailable` more easily is high-risk: it changes public labels on up to 954 sources.
- Never edit `source-status.json` by hand (T-03).

## Commands

```sh
node scripts/model-history/check-sources.mjs --dry-run --limit 5   # still makes requests, writes nothing
node --test scripts/model-history/test/check-sources.test.mjs
```

## Traps

T-03, T-07, T-09, T-16 · (no incident yet)
