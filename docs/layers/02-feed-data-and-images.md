# 02 · Feed data and images (the contract between build and readers)

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `data.json`, `feed.xml`, `digest.json` (only when enabled), `curated.json`, `img/`

## What this layer is

The published data files. They are written by the feed build (layer 01) and by nothing else, except `curated.json`, which the owner edits by hand. They are the only interface between the build and the readers.

## Files

### `data.json` (≈370 KB, ≈800 items)

Top level:

| Field | Meaning |
|---|---|
| `generated`, `lastFetchedAt` | build time (ISO) |
| `nextFetchAt` | next scheduled build; drives the dashboard countdown |
| `intervalMinutes` | 120 |
| `sources` | number of feeds (41); shown as "N sources" |
| `digest` | `true` only when a usable `digest.json` exists |
| `items[]` | newest first |

Item: `company` (exact registry `name`, e.g. `"Google (AI & DeepMind)"`), `source` (sub-label; `""` for xAI), `title`, `link`, `date` (RFC 822 UTC), `summary`, `image` (`img/<hash>.<ext>` or `""`), `id` (base-36 hash of the normalised link), and `about` (only on "Across AI" items that name a tracked company). Fields are additive; readers pick by name.

Readers: dashboard (`assets/app.js`, layer 03) and `match-news.mjs` (layer 08, which skips a run when fewer than 100 items arrive).

### `feed.xml`

RSS 2.0, 60 newest items titled `[<source or company>] <title>`, guid = link; when a digest exists it is the first item (`guid mm-digest-<date>`). Used for the Blogtrottr email subscription and the "RSS" links.

### `digest.json`

`{ v: 2, date, generated, items: [{ title, text, sourcePostId, company, link }] }`, 3–5 items. Absent unless `ANTHROPIC_API_KEY` is set. The dashboard shows it only when it is from today or yesterday (UTC), labelled "AI-generated".

### `curated.json`

`{ "_note": …, "items": [{ company, source, title, link, date, summary, image }] }`. Hand-picked pins for the Across AI card (currently three items). `company` defaults to "Across AI"; `date` may be ISO or RFC 822. They pass through the same image/summary pipeline and survive the item cap.

### `img/` (≈675 files, ≈134 MB)

Same-origin thumbnails, named by the first 16 hex characters of SHA-1 of the source URL; screenshots carry a `.shot` marker (`<hash>.shot.jpg`) so the screenshot block-list still recognises them after caching. Files no item references are deleted on every build, so **nothing else may live here** (T-02). It is the bulk of the repository's size.

## What this layer guarantees

- Everything the site serves is same-origin: no item points at a third-party image.
- `id` values match `^[0-9a-z]{1,16}$` and are unique within a file.
- A failing feed never empties its company (layer 01 carry-over).

## Change checklist

- Adding a field: additive only; update `normalize()` in `assets/app.js` only if the dashboard should show it; mention it in the README paragraph that lists the `data.json` fields.
- Removing or renaming a field breaks cached `index.html`/`app.js` combinations for up to 10 minutes (CDN) and the matcher: avoid.
- Never edit `data.json`, `feed.xml`, `digest.json` or `img/` by hand (T-02); the next build overwrites them and the commit history of the bot gets noisy.

## Traps

T-02, T-04, T-20 · M-003
