# Layers of AI Radar

One document per part of the system that does independent work. Read this page first, then the document of the layer you are about to change. Lessons learned are in [`../../mistakes.md`](../../mistakes.md) (incidents `M-nnn`, known traps `T-nn`); every layer document ends with the entries that concern it.

> **Status:** written 2026-10-27 from a full read of the repository at commit `f849768`. Each document has its own "Last verified" line; if you change a layer, update its document and that line in the same pull request.

## The big picture

```
 41 RSS/Atom feeds ──► [01 feed build] ──► data.json · feed.xml · digest.json · img/   [02 data contract]
        ▲                (every 2 h, Action)         │                  │
        │                                            ▼                  ▼
 curated.json (owner)                      [03 dashboard]        RSS / email (Blogtrottr)
                                                     ▲
 [04 content pages] ◄─ shared header/footer ─► [05 delivery & SEO: Pages, CNAME, sitemaps, robots]

 model-history/ (curated JSON, [06]) ──► [07 core + validator] ──┐
        ▲            ▲                                          ▼
        │            └── [14 new-model automation]       [10 generator] ──► models/ · sitemap-models.xml
        │                 (issues → Claude routine →            ▲   ▲                │
        │                  claude/ branch → auto-merge)         │   │                ▼
 [08 news matching] ◄── data.json                [09 source health]   └── state/*.json   [11 browser enhancements]
        │                                                 
 [12 tests + preview server]   [13 CI workflows run everything]   [15 docs, licences, releases]
```

## Layers

| # | Layer | One line | Main files |
|---|---|---|---|
| [01](01-feed-build.md) | Feed build | Fetches 41 feeds every 2 h, cleans, caches images, writes the data files | `scripts/build-feed.mjs` |
| [02](02-feed-data-and-images.md) | Feed data and images | The published contract: `data.json`, `feed.xml`, `digest.json`, `curated.json`, `img/` | `data.json`, `feed.xml`, `img/` |
| [03](03-dashboard-frontend.md) | Dashboard frontend | The home page: carousel, latest, company cards, timeline, live updates | `index.html`, `assets/app.js`, `app.css`, `tokens.css`, `registry.js` |
| [04](04-content-pages-and-site-shell.md) | Content pages and site shell | About, Contact, Privacy, Disclaimer, 404 and their shared shell | `about.html` …, `assets/pages.css`, `pages.js` |
| [05](05-site-delivery-and-seo.md) | Site delivery and SEO | GitHub Pages, custom domain, sitemaps, robots, favicon | `CNAME`, `.nojekyll`, `robots.txt`, `sitemap*.xml` |
| [06](06-model-history-data.md) | Model History data | Curated, source-backed records of models, organisations, families, sources | `model-history/` |
| [07](07-model-history-core-and-validator.md) | Core library and validator | Vocabulary, dates, ids, derivations, the E/W-code validator | `scripts/model-history/lib.mjs`, `derive.mjs`, `validate.mjs`, `schema/` |
| [08](08-model-history-news-matching.md) | News matching and new-name detection | Links posts to models; spots unknown model names | `match-news.mjs`, `backfill-news.mjs`, `state/news-links.json` |
| [09](09-model-history-source-health.md) | Source health | Daily check of every source URL and archive copy | `check-sources.mjs`, `state/source-status.json` |
| [10](10-model-history-generator.md) | Generator | Static Explorer, company, model and timeline pages | `build.mjs`, `templates.mjs`, `timeline.mjs` → `models/` |
| [11](11-model-history-frontend.md) | Model History frontend | Explorer filters/search, family chips, timeline tools, styles | `assets/models.js`, `model-pages.js`, `models.css` |
| [12](12-model-history-tests-and-preview.md) | Tests, fixtures, preview server | The only automated safety net, plus the local site server | `scripts/model-history/test/`, `serve.mjs` |
| [13](13-ci-workflows.md) | CI workflows | Who runs what, when, and who may write to `main` | `.github/workflows/*.yml` |
| [14](14-new-model-automation.md) | New-model automation | Issue → Claude routine → auto-merge of new records | workflow steps + claude.ai routine |
| [15](15-docs-licensing-release.md) | Docs, licences, release | README, CHANGELOG, licences, release flow, agent docs | `README.md`, `CHANGELOG.md`, `LICENSE` … |

## Who writes what (nothing else writes these)

| Files | Written by | Never by hand |
|---|---|---|
| `data.json`, `feed.xml`, `digest.json`, `img/` | Build combined feed (01, 13) | yes |
| `models/`, `sitemap-models.xml` | Model History build, only while `MODEL_HISTORY_PUBLISH=on` (10, 13) | yes |
| `model-history/state/news-links.json` | Model History build (08) | yes |
| `model-history/state/source-status.json` | Source health publish job (09) | yes |
| `model-history/records/`, `sources/`, `families.json`, `organizations.json` | the owner / pull requests; **new** models also the cloud routine via auto-merge (06, 14) | by PR |
| `curated.json`, `sitemap-pages.xml`, all HTML pages, `assets/*` | the owner / pull requests | by PR |

## Dependencies between layers (change one, check the other)

- 01 → 02 → 03, 08. The shape of `data.json` is the contract; copies of the id and "about" rules live in 01, 03 and 07 (T-01).
- `assets/registry.js` (03) is executed by 07 and 10 in a sandbox (T-12); company names must agree in 01, 03, 06 (T-13).
- 06 → 07 → 10 → 11; 08 and 09 feed `state/` into 10; 11 holds copies of vocabularies from 07 (T-15).
- 04 and 10 share a hand-copied page shell (T-11).
- 13 triggers 01, 08, 09, 10, 14; 14 depends on 08's regex and on 13's `[model-history]` trigger (T-08).

## Layers that have no automated tests

01 (feed build) and 03 (dashboard) — verify by hand as described in their documents. Everything in 06–11 is covered by the 372 tests in 12.

## Keeping this set honest

- Describe what the code does today, with file names, not plans.
- Numbers (test counts, record counts, line counts) age quickly; they are dated by the "Last verified" line.
- A new independent part of the system gets its own `NN-name.md` and a row above; a retired part gets a note and stays until nobody refers to it.
