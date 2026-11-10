# 12 · Tests, fixtures and the local preview server

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `scripts/model-history/test/` (9 test files, 372 tests), `test/fixtures/`, `test/make-fixtures.mjs`, `test/fake-dom.mjs`, `scripts/model-history/serve.mjs`

## What this layer does on its own

The only automated safety net of the repository (nothing tests `build-feed.mjs` or the dashboard), plus the tool to look at the generated site locally.

### Tests (`node:test`, no dependencies)

| File | Tests | Covers |
|---|---|---|
| `lib-derive.test.mjs` | 39 | `lib.mjs`, `derive.mjs`: dates, ids, id-function extraction, evidence, graph |
| `validate.test.mjs` | 126 | every validator code has a case (`fixtures/validator-cases/cases.json` patches an in-memory copy of the fixture; `fixtures/validator-broken/` for real broken files; temp dirs for E18/E29) |
| `match-news.test.mjs` | 31 | matcher, state handling, guards, report, backfill, new-name detection |
| `check-sources.test.mjs` | 64 | classification, hysteresis, scheduling, robots, archive lookups — fake fetch/sleep/clock, no network |
| `build.test.mjs` | 40 | generator through the CLI and `run()`, determinism (AC-26), atomic writing, publish gate, budgets (1000-model test) |
| `explorer.test.mjs` | 35 | `assets/models.js` in a `node:vm` sandbox with a fake DOM filled from the real rendered page; vocabulary copies equal `lib.mjs` |
| `model-pages.test.mjs` | 9 | `assets/model-pages.js` (chips, zoom, picker, Today marker) |
| `timeline.test.mjs` | 10 | event collection and per-zoom layout |
| `serve.test.mjs` | 18 | preview server rules, overlays, 404, path traversal |

### Fixtures

All data is **fictional** ("Example Lab", "Orbit", "Nova"; reserved example domains). `fixtures/basic/` is committed output of `make-fixtures.mjs`; `fixtures/build/` has a fictional registry and tracked data for the build tests. The real data is never used in tests.

### Preview server (`serve.mjs`)

Serves the repository (or `--root`) on `http://127.0.0.1:8125/` with the URL rules GitHub Pages applies (`/dir` → `/dir/`, `/page` → `page.html`, case-sensitive, root `404.html`). `--overlay /models=.preview/models` serves a path prefix (or a single file) from another directory so a preview build can be viewed without touching `models/`. Binds to 127.0.0.1 only, answers only `127.0.0.1:<port>`/`localhost:<port>` (DNS-rebinding guard), never serves outside the root/overlays (symlinks resolved).

## How to run

```sh
node --test "scripts/model-history/test/*.test.mjs"    # the quotes matter (T-18); ≈5 s; baseline 372/372
node scripts/model-history/build.mjs --publish --out .preview/models --sitemap .preview/sitemap-models.xml
node scripts/model-history/serve.mjs --overlay /models=.preview/models --overlay /sitemap-models.xml=.preview/sitemap-models.xml
```

Open `http://127.0.0.1:8125/` for the dashboard (needs `data.json`, present in the repo) and `/models/` for the preview.

## When tests run in CI

`model-history.yml` runs them on **pull requests** (not on pushes to `main`) and `model-history-auto.yml` runs them for every cloud-routine push. They run on Node 24; locally 22 works.

## What other layers rely on

- The tests are the guard for the copied code and vocabularies (explorer test, E18 test), for the publish gate, for determinism and for the "no network in tests" rule.
- A change to a template, vocabulary or schema shape that does not touch a test is probably a change nobody checks.

## Change checklist

- New behaviour → a test next to the nearest existing one; new validator code → a case in `cases.json` (the suite fails if a code lacks one).
- Do not make tests depend on the real `model-history/` data or on the network.
- Regenerating the fixture (`node scripts/model-history/test/make-fixtures.mjs`) deletes and rewrites `fixtures/basic/`; commit the result deliberately.
- Gap to be aware of: `build-feed.mjs` and `assets/app.js` have **no** tests; verify them manually (layers 01 and 03).

## Traps

T-17, T-18 · M-006 (failure path testing idea), M-008
