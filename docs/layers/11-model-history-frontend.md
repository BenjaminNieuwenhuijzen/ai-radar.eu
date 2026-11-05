# 11 · Model History frontend (browser enhancements)

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `assets/models.js` (596 lines), `assets/model-pages.js` (150), `assets/models.css` (393); shared with layer 04: `assets/tokens.css`, `assets/pages.css`, `assets/pages.js`

## What this layer does on its own

The generated pages (layer 10) are complete HTML. This layer only makes them nicer; **everything works without it** (the list, chronology and event list are all in the markup).

| File | Page | Job |
|---|---|---|
| `assets/models.js` | `/models/` (Explorer, design 1c) | Loads `/models/index.json` (its **only** request), then filters the existing `<li data-mh-model>` items by toggling `hidden` and reordering — it never rebuilds them. Facets: organisation, family, category, year, status, evidence, open weights; sort: date-desc/asc, name, organisation. Search runs in memory (diacritics-folded, separator-insensitive; ≥ 1000 models → 100 ms debounce). Facets and sort go into the URL via `history.replaceState`; **the search term never does**. Live count in an `aria-live` region. Error state with Retry. |
| `assets/model-pages.js` | company page, model timeline | Company page: family chips filter the chronology in place (items of other families `hidden`; empty years hidden; year counts follow). Timeline: zoom buttons (`data-zoom` on `#mh-tl`, CSS holds the three precomputed layouts), model picker (opens only on its button, WCAG 3.2.2), and the "Today" marker moved from the build's as-of day to the real today. No requests, no storage, nothing in the URL. |
| `assets/models.css` | all Model History pages | Styles for 1c Explorer, 1e Model Detail, 1a company page, 3a Timeline and the mobile layout (1f); tokens `--mh-ok`, `--mh-arch`, `--mh-sec`, `--mh-flag`. No web fonts, no images, no animation. Evidence state is always text plus glyph, colour is only a second carrier (WCAG 1.4.1). |

Privacy: same-origin only, no cookies, no storage keys, no analytics (T-20).

## What other layers rely on

- Markup contract from `templates.mjs`: `data-mh-view="explorer"`, `data-mh-model`, ids `mh-controls`, `mh-search`, `mh-sort`, `mh-facets`, `mh-clear`, `mh-count`, `mh-empty`, `mh-error`, `mh-retry`, `mh-list`, `mh-family-chips`, `chronology`, `mh-tl`, `mh-tl-zoom`, `mh-tl-today-label` … If `models.js` does not find the expected markup it leaves the static list alone.
- `models.js` contains **copies** of the vocabularies (categories, lifecycle, evidence, flags), label rules and `normalize`/`fold`/`compact`/`parseDate`/`sortKey` from `lib.mjs`/`derive.mjs`/`templates.mjs`. `explorer.test.mjs` compares them (T-15). A vocabulary or label change in the generator therefore needs the same change here.
- `/models/index.json` shape (`organizations`, `families`, `models`, `schemaVersion`, `generated`) — see `indexJson()` in `build.mjs`.
- Both scripts expose their pure functions to tests only when `globalThis.__MH_TEST__ === true` (the test runs them in `node:vm` with a small fake DOM, `test/fake-dom.mjs`).

## Change checklist

- Behaviour change → `explorer.test.mjs` (35 tests) / `model-pages.test.mjs` (9); stylesheet checks live in the same files.
- Check in a real browser against a preview build (layer 12): keyboard use, screen-reader announcements of the count, 375 px, light and dark, no request except `/models/index.json`.
- New facet or sort → URL keys must stay allow-listed (`own()` guards against `?sort=constructor`).
- Do not add storage or third-party requests (T-20).

## Commands

```sh
node --test scripts/model-history/test/explorer.test.mjs scripts/model-history/test/model-pages.test.mjs
```

## Traps

T-15, T-20, T-11 (the page shell is shared with layer 04)
