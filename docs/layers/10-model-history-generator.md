# 10 · Model History generator (static pages)

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `scripts/model-history/build.mjs` (621 lines), `templates.mjs` (924), `timeline.mjs` (167) → writes `models/` (≈588 files, ≈20 MB) and `sitemap-models.xml`

## What this layer does on its own

Compiles the curated data (06) plus the machine state (08, 09) into **pre-rendered static HTML and JSON**. No server, no client rendering needed: every page is complete without JavaScript; layer 11 only enhances it.

| Output | Content |
|---|---|
| `models/index.html` + `models/index.json` | Explorer (design 1c) with the whole list pre-rendered, and the search index the browser loads |
| `models/<org>/index.html` + `index.json` | Company Model History (design 1a style): chronology by year, family chips, lineage, evidence overview, related AI Radar coverage |
| `models/<org>/<slug>/index.html` | Model Detail (design 1e): every claim with its own evidence label and sources, lineage, variants, related coverage |
| `models/<org>/<slug>/timeline/index.html` | Model Timeline (design 3a): lifecycle, milestones, related models, source events and news on one axis, three zoom levels plus the same events as a list |
| redirect stubs | for `previousSlugs` / `previousRoutes` (unless a real page lives there) |
| `sitemap-models.xml` | indexable pages only (organisations with at least one `full` record, full models) |

## Pipeline (`build.mjs run()`)

1. `loadDataset` — unreadable data → exit 1, nothing written.
2. `loadRegistry` (runs `assets/registry.js` in a `node:vm` sandbox; failure → E25, fail closed).
3. **Validate** (layer 07) — any error → exit 1, nothing written.
4. `checkOutDir` / `checkSitemap` — refuse an output directory that could clobber source files and a sitemap path that is not its own earlier `sitemap-models.xml`.
5. `compile` — index, graph, news per model (`state/news-links.json` + `news.include − news.exclude`, one entry per post, merging the same story under two post ids within 2 days), company pages, redirects, source views (effective availability), `asOf` = the newest day the data itself mentions (not the clock).
6. `renderSite` → `finalize` (adds `generated` only when the rest of that JSON changed) → `diffOutput`.
7. **Publish gate:** files are written only with `--publish` or `MODEL_HISTORY_PUBLISH=on`; otherwise it prints what it *would* write and exits 0. Writing is atomic (temp dir swap or in-place sync with orphan removal).

Properties: deterministic (sorted keys, stable order, no timestamps in HTML; `SOURCE_DATE_EPOCH` honoured), Node built-ins only, every text through `escapeHtml` (the only unescaped markup is the inline logo SVG from the registry, which is repository code), size budgets per page (model 60 KB, company 150 KB, index 350 KB), route segments checked against `OUT_PATH` so a bad id can never write outside the output directory.

## File roles

- `build.mjs` — orchestration, news merging, JSON, sitemap, atomic writing, CLI.
- `templates.mjs` — pure string templates: labels (evidence, flags, "Incomplete record"), the **page shell** (same header/footer as `about.html`, T-11), Explorer, Company, Model, Timeline, redirect page. Keeps the semantic contract (`data-mh-*` attributes and ids) that layer 11 and the tests rely on.
- `timeline.mjs` — collects the dated events of one model and lays out labels per zoom in lanes; zoom switching is CSS-only in the browser, so the layout is computed here.

## What other layers rely on

- The URL scheme `/models/<org>/<slug>/` and `/timeline/` (links from the dashboard footer, the sitemap, news snapshots, redirects).
- `data-mh-*` attributes and element ids used by `assets/models.js` and `assets/model-pages.js` (T-15); `explorer.test.mjs` and `model-pages.test.mjs` render the generator's real output into a fake DOM, so a markup change breaks them on purpose.
- The workflows commit `models/` and `sitemap-models.xml` only when the gate is `on` (it is on since 2 October 2026).

## Change checklist

- Template change → run the fixture preview first (`--data scripts/model-history/test/fixtures/basic`), then the real data; check light/dark, 1280/1024/375 px, keyboard, console clean, no request to another host.
- Check the budgets (`build.test.mjs` has a 1000-model budget test) (T-21).
- Never hand-edit `models/` or `sitemap-models.xml` (T-03); CI regenerates them and removes orphans.
- A copied header/footer change → T-11.
- Always pass `--out` **and** `--sitemap` for previews, otherwise the tracked sitemap is overwritten.

## Commands

```sh
node scripts/model-history/build.mjs                                  # gate closed: validates and reports only
node scripts/model-history/build.mjs --publish --out .preview/models --sitemap .preview/sitemap-models.xml
node scripts/model-history/build.mjs --data scripts/model-history/test/fixtures/basic --publish --out .preview/models --sitemap .preview/sitemap-models.xml
node --test scripts/model-history/test/build.test.mjs scripts/model-history/test/model-pages.test.mjs scripts/model-history/test/timeline.test.mjs
```

## Traps

T-03, T-11, T-12, T-15, T-21 · M-007
