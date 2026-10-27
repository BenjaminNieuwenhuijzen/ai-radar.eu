# 05 · Site delivery and SEO

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `CNAME`, `.nojekyll`, `robots.txt`, `sitemap.xml`, `sitemap-pages.xml`, `sitemap-models.xml` (generated), `favicon.svg`, `404.html` (shared with layer 04), `.gitignore`

## What this layer does on its own

Defines how the repository becomes a website and how crawlers find it. There is no server code: **GitHub Pages serves the root of `main` as it is.**

| File | Effect |
|---|---|
| `CNAME` | `ai-radar.eu` — the custom domain (DNS and HTTPS are configured outside the repository) |
| `.nojekyll` | Disables Jekyll, so folders/files starting with `_` and all Markdown are served as plain files (this is why `README.md`, `CLAUDE.md`, `mistakes.md` and `docs/` are publicly readable) |
| `robots.txt` | Allows everything except `/model-history/` and `/scripts/` (raw data and build scripts); points to `sitemap.xml`. It is a request to crawlers, not access control |
| `sitemap.xml` | A `<sitemapindex>` of `sitemap-pages.xml` and `sitemap-models.xml` |
| `sitemap-pages.xml` | Hand-maintained list of `/`, `/about`, `/contact`, `/privacy`, `/disclaimer` with `lastmod`, `changefreq`, `priority` |
| `sitemap-models.xml` | **Generated** by the Model History build (layer 10): indexable `/models/…` pages only; committed only while the publish gate is on |
| `favicon.svg` | Radar icon, referenced by every page |
| `.gitignore` | OS/editor cruft, `node_modules/`, `.env*`, `.preview/` (local Model History preview), and the temporary folders of an interrupted atomic build (`/.models.tmp-*`, `/.models.old-*`, `/sitemap-models.xml.tmp-*`) |

## URL rules (GitHub Pages behaviour the site depends on)

- `/dir` → 301 to `/dir/`; `/page` serves `page.html` when it exists; paths are case-sensitive; unknown paths get the root `404.html` with status 404.
- The local preview server (layer 12) reproduces these rules; a link that works there works live.
- Everything in the repository is reachable by URL, including `model-history/` and `scripts/`.
- The CDN (Fastly) can show an old version for up to 10 minutes after a deploy; code that loads two files that must match (`index.html` + `registry.js`) has a guard for that (layer 03).

## What other layers rely on

- Extensionless internal links and `canonical`/`og:url` equal to the sitemap URLs (M-005).
- Taking Model History offline means: gate off, delete `models/` and `sitemap-models.xml`, turn `sitemap.xml` back into a plain `<urlset>` (README rollback table).
- `build.mjs` only overwrites a sitemap file that is its own earlier `sitemap-models.xml` (a `<urlset>` whose `<loc>`s all start with `https://ai-radar.eu/models/`); it will refuse to overwrite `sitemap.xml` or `feed.xml`.

## Change checklist

- New top-level page → page file, `canonical`/`og:url`, an entry in `sitemap-pages.xml`, link style per M-005, header/footer per T-11.
- New path that must not be crawled → `robots.txt` (and remember it is still public, T-04).
- Renaming the domain or the repository → search the old name everywhere (M-011).

## Traps

T-04, T-11 · M-005, M-011
