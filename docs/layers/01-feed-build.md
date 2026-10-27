# 01 · Feed build

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `scripts/build-feed.mjs`, `.github/workflows/build-feed.yml`

## What this layer does on its own

Every two hours (cron `17 */2 * * *`, minute 17 of every even UTC hour) a GitHub Action runs `node scripts/build-feed.mjs`. The script reads 41 RSS/Atom feeds, cleans and de-duplicates the posts, fills in missing images and summaries, downloads the images into the repository, optionally asks Claude Haiku for a daily briefing, and writes the files the rest of the site reads. Nothing else in the repository fetches news.

## Inputs → outputs

| Input | Where |
|---|---|
| 41 feeds: 39 for the 12 companies, 2 for "Across AI" (Google News query with `aiFilter` and `max: 15`, MIT Technology Review) | `FEEDS` array at the top of the script |
| Hand-picked pins | `curated.json` (optional, merged in; always survive the item cap) |
| Previous run's results | existing `data.json` (carry-over, image/summary cache), existing `digest.json` |
| Article pages | fetched for `og:image` / `og:description` when the feed lacks them (max 170 per run, 8 in parallel) |
| `ANTHROPIC_API_KEY` | optional secret; without it the digest feature stays dormant |

| Output | Consumer |
|---|---|
| `data.json` | dashboard (layer 03), Model History news matcher (layer 08) — see layer 02 for the contract |
| `feed.xml` | RSS readers and the Blogtrottr email subscription |
| `digest.json` | dashboard carousel, only when the key is set |
| `img/<sha1-16>[.shot].<ext>` | dashboard (same-origin thumbnails) |

## How it works (in order)

1. **Fetch every feed** (20 s timeout, UA `AIRadarBot/1.0`). Atom is detected as "has `<entry>` and no `<item>`". Titles/summaries go through `strip()` (entity decoding, tag stripping). `cleanMirrorTitle` repairs the Anthropic research mirror. Items are sorted newest first, then capped (`PER_FEED` 40, or the feed's `max`).
2. **Carry over on failure** (`carryOver`): a feed that errors, times out or yields zero usable items keeps its items from the previous `data.json` (items ≤ 30 days old; once per company+source). Log line: `kept N items from the previous build`.
3. **Merge `curated.json`**, sort, **de-duplicate by link** (`postKey`: no fragment, no trailing slash, lower-case), cap at `JSON_MAX` 800 (curated items exempt).
4. **Give each item a stable `id`** = base-36 `cyrb53(postKey(link))`, re-hashed with a seed on a (theoretical) collision.
5. **Images and summaries:** reuse cached values from the previous `data.json`; fetch `og:` metadata for the rest (never for `news.google.com`); blank summaries that repeat within a company; fall back to a thum.io screenshot URL except for `SCREENSHOT_BLOCK` hosts (`openai.com`, `x.ai`, `news.google.com`).
6. **Cache images first-party:** download each remote image once, store as `img/<hash>.<ext>` (content-addressed by URL), resize with ImageMagick when larger than 800 px and 200 KB, **delete every file in `img/` that no item references**.
7. **Digest** (`generateDigest`): once per UTC day, only with an API key; model `claude-haiku-4-5`, structured JSON output; items must point at an offered `sourcePostId`, 3–5 valid items or the previous digest is kept.
8. **Write `data.json`** (fields and schedule: layer 02), then **`feed.xml`** (top 60 items, plus the digest as the first item).

## What other layers rely on

- `id` stability (bookmarks in the browser, news-link snapshots in Model History): the hash functions are byte-identical copies in three files (T-01).
- Company names in `FEEDS` equal `registry.name` in `assets/registry.js` (T-13); unknown names are silently ignored by the dashboard.
- The schedule constants mirror the workflow cron (T-14).
- `data.json` additive-only changes: older readers pick fields by name.
- The workflow only commits `feed.xml data.json img` (+ `digest.json`); a new generated file must be added to its `git add` line.

## Change checklist

- New or changed feed → check ordering, description field and link type (M-003); run the script against it and read real titles (M-004).
- Failure paths: point one `FEEDS` url at a 404 and confirm the carry-over log line (M-006).
- Touching `ABOUT_RULES`, `cyrb53`, `postKey`, `postId` → mirror in `assets/app.js` and `scripts/model-history/lib.mjs`, then run the validator (E18).
- Changing `JSON_MAX`, `PER_FEED` or the item shape → check `data.json` size (≈370 KB today) and `explorer`/`match-news` tests.
- Run locally only to test; discard the generated files (`git checkout -- data.json feed.xml img; git clean -fd img`).

## Commands

```sh
node scripts/build-feed.mjs   # Node 20+; ImageMagick optional; makes ~170 article requests
node --check scripts/build-feed.mjs
```

There is no unit test file for this script; the `match-news` tests exercise `data.json` consumers with fixtures.

## Traps

T-01, T-02, T-13, T-14, T-16, T-17 · M-003, M-004, M-006 (see `mistakes.md`)
