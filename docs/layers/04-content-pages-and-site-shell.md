# 04 · Content pages and site shell

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `about.html`, `contact.html`, `privacy.html`, `disclaimer.html`, `404.html`, `assets/pages.css`, `assets/pages.js`

## What this layer does on its own

The static, hand-written pages that tell visitors who runs AI Radar and what is automated, how privacy is handled, what the legal limits are, and how to reach the owner. They also define the **page shell** (header, footer, reading column, theme/motion buttons) that Model History pages reuse.

| Page | Content |
|---|---|
| `/about` | What the dashboard shows, where posts come from, Model History, **what is automated and therefore fallible**, who makes it |
| `/contact` | What to write about, source and removal requests (`info@ai-radar.eu`, no form), privacy, elsewhere |
| `/privacy` | Controller, what is stored on the device (the three `airadar-*` keys), hosting (GitHub Pages / Fastly, domain at TransIP), where content comes from, optional email via Blogtrottr, rights |
| `/disclaimer` | Aggregator not a source, no warranty, automated categorisation, brands, external links, email delivery, personal project |
| `404.html` | Not-found page with links to the dashboard and the Explorer; `noindex`; served by GitHub Pages for unknown paths |

## Shared assets

- `assets/pages.css` — standalone (does **not** load `app.css`): header, reading column (`.doc`, serif body), footer, mobile rules, 44 px tap targets. Builds on `tokens.css`.
- `assets/pages.js` — theme and motion toggles for pages that only carry the buttons: reads/writes `airadar-theme` / `airadar-motion`, follows system changes while no choice is stored, syncs across tabs via the `storage` event.
- Every page has an inline **pre-paint script** that sets `data-theme` / `data-motion` before first paint (same logic as `index.html`).

## What other layers rely on

- The header/footer markup is **copied by hand** into `index.html`, these five pages and `page()` in `scripts/model-history/templates.mjs`; a navigation change must be made everywhere (T-11). The generated Model History pages are rebuilt by layer 10.
- Statements about automation, AI involvement, storage keys and removal requests must match what the system really does (M-010). They are the public promise for layers 06 and 14: "drafted with AI assistance", "new models are added by an AI agent and published without prior human review".
- Links are extensionless (`/about`, `/contact`, …) and each page has `canonical` and `og:url` (M-005); the sitemap entries live in layer 05.

## Change checklist

- Changed storage, a network request, an analytics-like feature, a hosting detail or an email flow → `privacy.html` (+ `README.md`) in the same PR.
- Changed automation or review of Model History → `about.html`, `disclaimer.html`, `model-history/README.md`, CHANGELOG (M-010).
- Changed the header/footer → all pages from T-11, plus a Model History preview build to confirm the generated pages still match.
- Bump `lastmod` in `sitemap-pages.xml` when a page's content changes materially.
- Check light/dark, 375 px width, keyboard focus, console clean.

## Traps

T-04, T-11, T-20 · M-005, M-010
