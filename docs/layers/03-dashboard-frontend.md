# 03 · Dashboard frontend

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `index.html`, `assets/app.js` (1 203 lines), `assets/app.css`, `assets/tokens.css`, `assets/registry.js`

## What this layer does on its own

The home page `https://ai-radar.eu/`. In the browser it loads `/data.json` (and `/digest.json` when `data.json` says `"digest": true`) from its own domain and renders: a **Today in AI** carousel, a **Latest** column, a sticky filter bar (By company / Timeline, category chips, search, Saved) and the feed. It needs no build step and has no dependencies; there is no fallback to live feeds or proxies — if `data.json` cannot be loaded the page shows an error with Retry and the RSS link.

## Files and their jobs

| File | Job |
|---|---|
| `index.html` | Markup with skeletons, SEO/social meta, JSON-LD, the **pre-paint script** that sets `data-theme` / `data-motion` from `airadar-theme` / `airadar-motion` (and migrates `mm-theme`), the Blogtrottr subscribe band, footer. Loads `registry.js` then `app.js` (both `defer`). |
| `assets/app.js` | All behaviour, one IIFE. Sections: config · logos/companies/categories · helpers · taxonomy · storage · state · data · render helpers · header · carousel · latest · feed · live updates · theme & motion · events · init. |
| `assets/registry.js` | `window.AIRadarRegistry`: the 12 companies + "Across AI" (`id`, `name` = data.json string, `display`, `hue`, `official`, `aggregate`) and inline SVG logos; `logoFor()` makes SVG ids unique. **Shared with Model History** (layer 10 runs it in a Node sandbox). |
| `assets/app.css` | Layout and components; every animation is gated on `:root[data-motion="on"]`; breakpoints mobile < 768, tablet 768–1023, desktop ≥ 1024. |
| `assets/tokens.css` | Colours (light/dark by `data-theme`), per-company oklch hue, fonts (system stacks only), shared with the content pages and Model History. |

## Behaviour worth knowing

- **Data flow:** `fetchData()` (`cache: "no-cache"`) → `normalize()` (drops unknown companies, non-http links, bad dates; accepts only base-36 ids; derives `about`, categories, `model` flag, search haystack) → `applyData()` → render.
- **Live updates:** a 1 s `tick()` drives the countdown to `nextFetchAt` (fallback arithmetic = cron `17 */2 * * *`); at zero and every 5 min `poll()` re-fetches. New posts wait behind a "↑ N new posts" pill; failures show an Offline bar with Retry.
- **Carousel:** digest slides when a recent digest exists, otherwise auto-picked (model releases first, one per company, posts with image, last 72 h → widened to 7 d). 7 s autoplay as a CSS animation; pauses on hover/keyboard focus/hidden tab/Motion off.
- **Classification:** `categorizeAll()` is a keyword heuristic giving each post up to several categories (keys `model`, `product`, `onderzoek`, `developer`, `hardware`, `applied`, `funding`, `safety_policy`, `overig` — some keys are Dutch, URL slugs are English). `isModelUpdate()` drives the "Model releases" chip and the carousel.
- **Views:** company cards (ordered by posts this week, then newest; 4 posts, expand to 12, "All N in Timeline →") and a day-grouped timeline (50 per "Load more"). View, category and the timeline's company live in the URL (`?view=timeline&cat=model-releases&company=openai`); the search term does not.
- **Storage:** only `airadar-theme`, `airadar-motion`, `airadar-saved` (post ids). Old keys (`mm-*`, `ai-dashboard-cache-v3`) are migrated or removed on first visit. All storage access is wrapped in try/catch.
- **Security:** feed text is untrusted; everything interpolated into markup goes through `esc()`, links through `safeLink()`, images through `safeImage()` (same-origin relative paths only).
- **Cache-skew guard:** an `index.html` cached from before `registry.js` existed loads `app.js` first; `app.js` then loads the registry and re-runs itself.
- **Debug hook:** `window.__airadar` (`poll`, `load`, `applyPending`, `goSlide`, `state`).

## What other layers rely on

- `data.json` contract (layer 02) and the company names/ids in `registry.js`.
- `registry.js` is loaded by the Model History generator (T-12), so its shape (`logos`, `companies`, `logoFor`) is an interface.
- Copies that must match the build: `cyrb53`/`postKey`/`postId`, `ABOUT_RULES`/`aboutCompany`, cron arithmetic (T-01, T-14).
- The header/footer markup is hand-copied across pages (T-11).

## Change checklist

- No automated tests cover this layer. Check by serving the root (`node scripts/model-history/serve.mjs`) and loading `/` at 375, 768 and 1280 px, light and dark, Motion on and off, keyboard only, console clean, **no request to another host**.
- Adding a company → registry + `FEEDS` + `ABOUT_RULES` + Model History organisation (T-13).
- Adding storage or a network request → privacy page and README change (T-20).
- Pointer interactions: capture on a stable ancestor (M-001).
- `app.js` is also in the Model History workflow's `paths` filter, so edits trigger validation (E18 compares the id functions).

## Traps

T-01, T-11, T-12, T-13, T-14, T-20 · M-001, M-005
