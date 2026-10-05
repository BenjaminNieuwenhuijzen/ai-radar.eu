# Changelog

All notable changes to AI Radar are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/).

Each released version below links to a comparison with the previous one, so you
can see exactly what changed between any two versions.

## [Unreleased]

### Added
- Model History now covers all 12 tracked companies: Google, OpenAI, Mistral AI, DeepSeek, xAI,
  Microsoft, NVIDIA, Cohere, Meta, Hugging Face and Perplexity joined Anthropic (279 models,
  952 sources), with relations across organisations (for example R1 1776 → DeepSeek-R1).
- **Automatic updates for new models.** The Model History build opens a `new-model` issue for
  every model name in AI Radar titles that no record knows (at most 5 per run, never twice for
  one name). A daily Claude routine in the cloud researches those names and pushes new records;
  the new `model-history-auto.yml` workflow publishes them only when they change curated data
  alone and pass validation, the tests and validation after news matching, and otherwise
  comments on the issue.

### Changed
- About and Disclaimer say that new models are added by an AI agent and published without
  prior human review.
- The last 14 sources with an unknown status were checked by hand and are active.

### Fixed
- The Model History build failed when a feed item had no source (the xAI feed): a news
  snapshot now names the link's host instead.

## [2.1.0] - 2026-10-02

**Model History**: a source-based history of AI models, starting with Anthropic's 32 models; the other tracked companies follow. At
[/models/](https://ai-radar.eu/models/).

### Added
- **Explorer** (`/models/`) with search, filters (organisation, family, category, year,
  status, evidence, open weights) and sorting; the filters live in the URL, the search term
  never does.
- A page per **organisation** with its chronology by year, family chips, lineage, an
  evidence overview and related AI Radar coverage.
- A page per **model**: every claim (dates, status, relations, changes, capabilities) with its
  own evidence label and sources; lineage; variants; related coverage.
- A **timeline** per model (`/models/<org>/<slug>/timeline/`) with lifecycle, milestones,
  related models, source events and coverage on one axis, three zoom levels and the same
  events as a list.
- Dates keep the precision of the source (a month stays a month); sources show whether the
  original is active, only archived or unavailable.
- Automatic links from AI Radar posts to models, kept as snapshots after the posts leave
  the live feed; a daily check of every source address.
- "Model History" in the header and footer of every page; a `404` page; `sitemap.xml` is now
  an index of `sitemap-pages.xml` and `sitemap-models.xml`.

### Changed
- The company registry (companies and logos) moved from `assets/app.js` to
  `assets/registry.js`, shared by the dashboard and Model History.
- The feed build rebases before it pushes, so it and the Model History build can both write
  to `main`.
- About, Privacy, Disclaimer and Contact describe Model History: its own editorial content
  (drafted with AI assistance from the cited sources), the automatic source status and news
  links, links to archived copies, and how removal requests work for historical records.

### Fixed
- A feed that fails during a build (an HTTP error, a timeout, or no usable items) now keeps its
  items from the previous build instead of disappearing until the next one. On 1 October 2026
  Google News answered 503 once and the DeepSeek card showed only two old GitHub releases.

## [2.0.0] - 2026-09-30

A redesign of the dashboard and the content pages (direction 1c "Hybrid"), on the same
feed pipeline. The redesign block comes first. The entries after it went live on
ai-radar.eu between 1.0.0 and the redesign and are part of this release too; the
redesign replaces a few of them (for example drag-to-reorder, the masonry grid and the
top-story block), as listed under its **Changed** and **Removed** headings.

### Changed — redesign

#### Added
- **Today in AI** carousel with up to five top stories. Without a digest they are
  auto-selected and labelled **Auto-selected**: recent model releases first, one per
  company, posts with an image from the last 72 hours (widened to 7 days when that is
  too thin). Autoplay every 7 seconds with a progress bar; it pauses on hover, on keyboard
  focus, in a background tab and with motion off, and a pause button (always shown on
  phones) stops it. Arrows, arrow keys and swipe navigate.
- **Latest** column with the five newest posts, next to the carousel.
- Live status in the header: last update, a countdown to the next scheduled build and
  the number of sources. The page checks `data.json` every five minutes and when the
  countdown ends; new posts wait behind a "↑ N new posts" pill. A failed check shows an
  Offline state and a Retry bar; a failed first load shows a message with Retry.
- **Motion** toggle, stored as `airadar-motion`, following the system's reduced-motion
  setting until used.
- View and category in the URL (`?view=timeline&cat=model-releases`), so a filtered view
  can be shared.
- Across AI posts show the logo of the company they are about, or the outlet's initials.
- `data.json` fields: a stable `id` per item, `about` on Across AI items that name a
  tracked company, and `lastFetchedAt`, `nextFetchAt`, `intervalMinutes`, `sources` and
  `digest` at the top level. The dashboard derives the missing ones for older files.
- Digest format v2 in the build: 3 to 5 items, each tied to a `data.json` post by
  `sourcePostId`. The page requests `digest.json` only when `data.json` says
  `"digest": true`. Still optional and dormant without `ANTHROPIC_API_KEY`.
- Shared design tokens (`assets/tokens.css`) and a new `favicon.svg`; the about,
  contact, privacy and disclaimer pages share the new header, footer and theme toggle
  (`assets/pages.css`, `assets/pages.js`).

#### Changed
- The dashboard moved out of the single `index.html` into `assets/app.js`,
  `assets/app.css` and `assets/tokens.css`: plain JavaScript, no dependencies, no build
  step.
- Company cards sit in a three-, two- or one-column grid, ordered by posts this week and
  then the newest post. A card shows its latest post plus three rows (two on mobile) and
  expands to at most 12, with "All N in Timeline →" for the rest. The card's source
  label reads "Official feed", "Community feed" or, for Across AI, "Industry news".
- The timeline groups posts by day with a count per day and pages 50 rows at a time.
- Categories are a row of chips in a sticky filter bar, together with the view switch,
  search and Saved.
- The "Saved only" checkbox is now a "Saved · N" toggle, and every post has a bookmark
  button. Saved posts are stored as post ids in `airadar-saved`; the old link list
  (`mm-saved-v1`) is migrated.
- All times and the day grouping are in UTC, like the build schedule, with short
  relative times ("12m", "3h") on the cards. This replaces the local-timezone
  "today, 13:00" format.
- The theme control is a Light/Dark toggle that follows the system setting until used;
  the key is now `airadar-theme` (migrated from `mm-theme`).
- System fonts only, no web fonts. Each company has one colour hue; company names set as
  text use a darker shade so every hue passes WCAG AA.
- The about and privacy pages describe the auto-selected stories, the new storage keys
  and the absence of third-party requests.
- The `feed.xml` digest item reads both v1 and v2 digests.

#### Removed
- Drag-to-reorder of the company cards and the **"Auto order"** button (`mm-order-v1`).
- The company multi-select (`mm-companies-v1`), the period filter and the **Filters**
  disclosure.
- "New since your last visit" markers (`mm-seen-v1`) and the remembered view (`mm-view`).
- The localStorage feed cache (`ai-dashboard-cache-v3`) and the live-feed fallback
  through public CORS proxies, so the page makes no third-party requests at all.
- The top-story hero with its "More top stories" rail, the separate digest list, the
  masonry card layout, the footer's **About AI Radar** paragraph and the per-card source
  links. Keys of removed features are deleted from localStorage on the first visit.

### Added
- Custom domain **ai-radar.eu**: added a `CNAME` and pointed all site URLs (README,
  `feed.xml`, build script, Blogtrottr link) at it, plus branding/SEO meta tags
  (description, canonical, Open Graph, Twitter card) in `index.html`.
- Drag-to-reorder the company cards. Drag a card by its grip handle to set your own
  order; it is remembered locally per browser and overrides the automatic activity
  ranking until you press **"Auto order"**. Works with mouse and touch.
- DeepSeek added as the 12th tracked company. It publishes no native or community RSS
  feed, so its card is fed by the official `deepseek-ai` GitHub release feeds plus a
  Google News query for current coverage, and is labelled a community source. Google
  News article links are excluded from screenshot thumbnails, so they fall back to the
  brand placeholder instead of a redirect page.
- Atom feed support in the build (`<entry>` / `<published>` / `<updated>` /
  `<link href>`), alongside the existing RSS `<item>` parsing.
- Many more sources per company — **12 → 36 feeds across the same 11 companies**:
  developer / research / engineering blogs, official newsrooms, product and
  release-note changelogs, and each company's official YouTube channel.
- Mistral now reads its official native feed instead of the community mirror.
- Three new per-post categories — **Hardware & Infrastructure**, **Developer & How-to**
  and **Applied AI** — while the old **Company** and **Safety** tags were broadened into
  **Business & Funding** and **Safety & Policy**, taking the taxonomy from 6 to 9.
- Multi-category post labels: a post can now carry more than one category chip (up to
  three, in priority order) instead of only its top match, so a model release that is
  also a policy story (e.g. "Redeploying Fable 5") shows both **Model release** and
  **Safety & Policy** rather than the first match alone. The category filter now matches
  any of a post's categories, which surfaces the model releases (~20 of them) that were
  hidden behind a higher-priority label under the **Model releases** filter.

### Changed
- The **Across AI** card now fills itself. It reads a tuned Google News query plus MIT
  Technology Review's AI-topic feed; the news query is capped per run and passed through
  an AI-relevance keyword filter, so general-press noise can't flood the card or the
  combined email feed. `curated.json` still merges in as optional hand-picked pins.
  The card's header label changed from **Curated · Editorial picks** to
  **Aggregated · Google News + MIT Tech Review**; as before, the card stays out of the
  footer's company count and official/community mix. (Import AI was also verified as a
  source, but Substack 403-blocks GitHub's runner IPs, so it remains a card link only.)
- Per-feed item caps now keep the **newest** items instead of the first in document
  order: Google News search RSS is relevance-ordered, so the old cap could hold on to
  week-old evergreen hits while dropping same-day news (this also freshens the DeepSeek
  card). Google News items no longer carry their redundant link-list description — which
  rendered as literal `&nbsp;&nbsp;` text — and no longer burn the article-metadata fetch
  budget on their redirect links, freeing ~55 of the 170 fetch slots per run for real
  articles.
- Trimmed the homepage footer to cut duplication with the standalone pages: the long
  **Disclaimer** paragraph is now a one-line pointer to the full `/disclaimer` and `/privacy`
  pages, and the **Updates in your inbox** blurb no longer repeats the Blogtrottr/email detail
  that already lives on `/privacy`. The **About AI Radar** explainer stays, as it has no other home.
- `rssImage` skips non-image `media:content` (e.g. YouTube's video URL) and tiny
  author avatars (GitHub release feeds), so the real thumbnail is used.
- Items are de-duplicated by link, so overlapping feeds for one company (e.g. its
  AI-tag and full newsroom) no longer produce duplicates.
- Raised the dashboard item cap (`JSON_MAX`) from 360 to 800 for the larger feed set.
- Items published today now show the publication time (e.g. "today, 13:00") in the
  reader's local timezone; date-only feeds still show just "today".
- Tidied the header: dropped the "View"/"Search" caption labels (kept as `aria-label`)
  and removed the Refresh button, so the controls align on one centered row and the
  bar is shorter.
- Rewrote the automatic category classifier as a priority-ordered keyword chain (first
  match wins). Cut the uncategorised **Other** bucket from ~29% to ~12% of items and
  broke up the over-stuffed **Product** bucket, fixing rule gaps along the way (e.g.
  "fundraising" and the plural "APIs" were previously missed).
- The **Top story** block now leads with model releases: the hero lead card and the
  "More top stories" rail are both filled from the most recent model releases (30-day
  window), falling back to the newest items only when there are too few. The rail may
  repeat a company, since the aim is to surface releases rather than spread across
  companies.

### Removed
- The **Cookiebot** cookie-consent tool, from every page. The dashboard sets no cookies,
  has no analytics or tracking, and stores only strictly functional data in the browser,
  so no consent is required under the GDPR/ePrivacy rules; the banner added nothing but
  its own third-party requests and a consent cookie. The privacy statement already
  described this.

### Fixed
- Company cards now use a masonry layout (a CSS grid whose column count and per-card
  row spans are computed in JS) instead of fixed-height rows, so cards fill
  left-to-right and pack tightly by their own height: no empty gaps under short cards
  and no ragged, uneven bottoms. Toggling companies reflows the rest left-to-right;
  filtering and drag-to-reorder still work.
- All internal links now use clean, extensionless URLs (`/`, `/privacy`, `/disclaimer`,
  `/contact`) instead of `*.html`, matched by the `canonical`/`og:url` tags and the
  sitemap, so the address bar never shows `.html`. GitHub Pages serves the
  extensionless paths.
- Anthropic research-mirror titles that glued the date, section label and headline into
  one string (e.g. "Jun 18, 2026Frontier Red TeamProject Fetch: Phase two") are now
  cleaned at build time down to just the headline.

## [1.0.0] - 2026-06-16

First tagged release. AI Radar (formerly "Model Monitor") aggregates news from 11
AI companies into a single GitHub Pages dashboard, refreshed every two hours by a
scheduled GitHub Action.

### Added
- By-company grid and a chronological timeline view; the grid is ordered by how
  active each company has recently been in the news.
- Top-story hero with a "more top stories" rail of other recent headlines.
- Optional daily "Today in AI" briefing generated server-side with Claude Haiku,
  shown on the page and prepended to the RSS feed (requires the `ANTHROPIC_API_KEY`
  repository secret; dormant and harmless without it).
- Filters by category, company and period; free-text search; and a per-article
  save list with a "Saved only" filter.
- Light / dark / auto theme switcher; preferences stored locally, no tracking.
- "New since your last visit" markers that persist across sessions, "Show more" /
  "Show less" per feed, and "Load more" in the timeline.
- Email subscription via Blogtrottr from a combined RSS feed, plus a direct RSS link.

### Changed
- Rebranded from Model Monitor to AI Radar, including a new radar logo.
- Decluttered the header behind a "Filters" disclosure and added a mobile breakpoint.
- Footer text is generated from configuration (company count, official/community
  feed split, category list).

### Accessibility
- `aria-live` status line, `aria-pressed` on the view and category toggles, and
  "/" to focus search.

### Documentation
- English README, MIT license, `.gitignore`, and all code comments translated to
  English.

[Unreleased]: https://github.com/BenjaminNieuwenhuijzen/ai-radar.eu/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/BenjaminNieuwenhuijzen/ai-radar.eu/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/BenjaminNieuwenhuijzen/ai-radar.eu/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/BenjaminNieuwenhuijzen/ai-radar.eu/releases/tag/v1.0.0
