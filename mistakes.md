# mistakes.md — what went wrong in AI Radar, so it does not happen twice

**Read this file at the start of every session**, before changing anything (`CLAUDE.md` loads it automatically).
Then read the layer document in [`docs/layers/`](docs/layers/README.md) for the part you are about to touch.

This file is public: GitHub Pages serves the whole repository. Never write secrets, tokens, private URLs or personal data here.

## How to use and maintain this file

**Add an entry when** CI, a reviewer, the owner or you yourself finds a defect, a wrong assumption, a revert, or a command that failed for a reason you could have known. Write it in the same session, in the same PR as the fix.

**An entry says**: what went wrong, the root cause (not the symptom), and a **rule** that would have prevented it. A rule is something checkable ("run X before Y"), not an intention ("be careful").

Keep entries short. Do not delete entries; if a rule no longer applies (the feature is gone), mark the entry `Status: obsolete` and say why. Entries are in chronological order of discovery; **append new entries at the end of the incident list**. Next free ID: **M-014**.

```
### M-NNN · short title
- **Date:** YYYY-MM-DD · **Layer:** NN-name (docs/layers/) · **Evidence:** PR / commit / file
- **What happened:** …
- **Root cause:** …
- **Rule:** …
- **Status:** active | obsolete (reason)
```

Entries M-001 to M-013 were reconstructed on 2026-10-27 from the pull-request history, the CHANGELOG and the README. The clone in cloud sessions is shallow and almost all recent commits are bot commits ("Update feed data"), so `git log` shows little: look at closed pull requests (`mcp__github__list_pull_requests`, state `all`) instead.

## Before you push: checklist distilled from the entries below

1. `node scripts/model-history/validate.mjs` → 0 errors, and `node --test "scripts/model-history/test/*.test.mjs"` → all pass (baseline 2026-10-27: 372/372, 0 errors, 62 warnings). The quotes around the glob matter. (M-007)
2. Touched `model-history/` data? Also run `node scripts/model-history/match-news.mjs && node scripts/model-history/validate.mjs`, then `git checkout -- model-history/state`. PR checks do not do this; the build on `main` does. (M-007)
3. Never edit generated files by hand: `data.json`, `feed.xml`, `digest.json`, `img/`, `models/`, `sitemap-models.xml`, `model-history/state/*`. (T-02, T-03)
4. Changed `cyrb53`/`postKey`/`postId` or `ABOUT_RULES` in one place? Change every copy (T-01).
5. Changed who writes or publishes content (automation, review step)? Update About, Disclaimer, README and CHANGELOG in the same PR. (M-010)
6. Never put `[model-history]` in a commit message on a `claude/**` branch unless you want it squashed onto `main` automatically. (T-08)
7. After bulk edits or generated text, check for stray NUL bytes: `grep -rlP '\x00' --include='*.{js,mjs,css,html,md,json}' .` should print nothing. (M-002)
8. Use absolute paths; do not `cd` into subfolders in the shell tool. (M-013)
9. Changed behaviour of a layer? Update its `docs/layers/NN-*.md` ("Last verified" line included).

---

## Incidents

### M-001 · Drag-to-reorder froze after the first move, then stuck to the cursor
- **Date:** 2026-06-17 · **Layer:** 03-dashboard-frontend · **Evidence:** PRs #2 and #3
- **What happened:** Dragging a company card froze after one move; after the fix the card stayed attached to the cursor after release.
- **Root cause:** The pointer was captured on the grip handle. Moving the card in the DOM (`insertBefore`) reparented the captured node, and Chromium fired `lostpointercapture`, which ended the stream of `pointermove` events. The first fix listened on the grid, which missed `pointerup` outside it.
- **Rule:** Capture pointers on a stable ancestor and listen for `pointermove`, `pointerup` and `pointercancel` on `document`; never capture on a node you are about to move or re-render. (The feature was removed in 2.0.0; the carousel swipe in `assets/app.js` uses plain pointer events on `#slides` and has no capture. Keep it that way.)
- **Status:** obsolete for drag-to-reorder; the rule applies to any future pointer interaction

### M-002 · Stray NUL bytes replaced spaces in strings
- **Date:** 2026-06-17 · **Layer:** all (found in the old inline dashboard script) · **Evidence:** PR #2
- **What happened:** Two NUL bytes replaced the spaces in `join(" ")` order-comparison strings. Git and grep treated the file as binary and the comparison silently failed.
- **Root cause:** A text-processing step wrote NULs; nobody checked the result byte-wise.
- **Rule:** After generated or bulk-edited text, run the NUL check from the checklist above. If `git diff` says "Binary files differ" for a source file, stop and investigate.
- **Status:** active

### M-003 · Google News quirks hit the Across AI and DeepSeek cards (several symptoms)
- **Date:** 2026-06 (v2.0.0 changes) · **Layer:** 01-feed-build · **Evidence:** CHANGELOG 2.0.0 "Changed" and "Added"
- **What happened:** Google News search RSS is relevance-ordered, so a per-feed cap in document order kept week-old evergreen hits and dropped same-day news; its descriptions rendered as literal `&nbsp;&nbsp;` text; its article links are redirect interstitials, so the screenshot fallback (thum.io) captured the redirect page instead of the story, and the metadata fetch burned budget on links that have no `og:` tags.
- **Root cause:** One feed type was treated like the date-ordered publisher feeds.
- **Rule:** Sort parsed items by date *before* capping (`parsed.sort(...)` then `slice`); drop Google News descriptions; keep `news.google.com` in `META_BLOCK` and `SCREENSHOT_BLOCK`. When adding a feed of a new kind, check its ordering, its description field and its link type first.
- **Status:** active

### M-004 · Community mirror glued date, section label and headline into one title
- **Date:** 2026-06 (v2.0.0 fix) · **Layer:** 01-feed-build · **Evidence:** CHANGELOG 2.0.0 "Fixed"; `cleanMirrorTitle` in `scripts/build-feed.mjs`
- **What happened:** The Anthropic research mirror produced titles like "Jun 18, 2026Frontier Red TeamProject Fetch: Phase two".
- **Root cause:** A community mirror scrapes a page without separators; the build trusted the text.
- **Rule:** New community mirrors: read a few real titles before trusting them. Fix mangling per company in `cleanMirrorTitle`, gated narrowly (here: Anthropic and a glued year such as `2026F`) so normal titles are never touched.
- **Status:** active

### M-005 · Internal links used `*.html` while canonical URLs and the sitemap were extensionless
- **Date:** 2026-06 (v2.0.0 fix) · **Layer:** 04-content-pages-and-site-shell, 05-site-delivery-and-seo · **Evidence:** CHANGELOG 2.0.0 "Fixed"
- **What happened:** The address bar showed `.html` on some navigations although `canonical`, `og:url` and the sitemap use `/about`, `/privacy`, …
- **Root cause:** Links, canonical tags and sitemap were maintained separately.
- **Rule:** Link to `/about`, `/contact`, `/privacy`, `/disclaimer` and `/models/…/` only (GitHub Pages resolves `/about` to `about.html`). A new page needs its link style, `canonical`, `og:url` and a `sitemap-pages.xml` entry together.
- **Status:** active

### M-006 · One failed feed emptied a company card (Google News HTTP 503)
- **Date:** 2026-10-01 · **Layer:** 01-feed-build · **Evidence:** PR #6; comment above `carryOver()` in `scripts/build-feed.mjs`; CHANGELOG Fixed (2.1.0)
- **What happened:** The 08:56 UTC build got 503 from Google News for the DeepSeek and Across AI queries. The build dropped those feeds, and the DeepSeek card showed only two GitHub releases from June 2025 until the next build.
- **Root cause:** A feed failure was treated as "this feed has no items".
- **Rule:** A fetch that fails, times out, or returns zero usable items must keep that feed's items from the previous `data.json` (up to `CARRY_DAYS` = 30 days old). New feeds go through the same path. Test failure handling by pointing one `FEEDS` url at a 404 and checking the log line `kept N items from the previous build`.
- **Status:** active

### M-007 · A data PR passed its checks and then broke the `main` build
- **Date:** 2026-10-05 · **Layer:** 06-model-history-data, 08-model-history-news-matching, 13-ci-workflows · **Evidence:** PR #9 → PR #10; README step 7 in `model-history/README.md`; PRs #11, #14 repeat the lesson
- **What happened:** "Model History: add 10 more companies" (PR #9) was green, merged, and the next build on `main` failed validation: after the news matcher linked posts to the new records, a snapshot was invalid (see M-008).
- **Root cause:** The PR check runs `validate.mjs` and the tests only. The `main` build also runs `match-news.mjs` (which writes `state/news-links.json`) and validates **again**. A new alias can link posts whose snapshot then fails.
- **Rule:** Before merging any change to `model-history/records`, `sources`, aliases, `organizations.json` or `families.json`: run `node scripts/model-history/match-news.mjs && node scripts/model-history/validate.mjs`, then `git checkout -- model-history/state`. `model-history-auto.yml` does the same for the cloud routine; do it by hand for everything else.
- **Status:** active

### M-008 · A feed item without `source` made the Model History build fail on `main` (see M-007)
- **Date:** 2026-10-05 · **Layer:** 08-model-history-news-matching · **Evidence:** PR #10 "Fix Model History build for feeds without a source"
- **What happened:** The xAI feed items carry no `source`. After 11 news links to the new xAI records were written, the post-match validation reported E17 (incomplete news snapshot) and the build failed.
- **Root cause:** The matcher copied `source` as-is; the schema requires it. One of the 12 feeds had never produced a link before.
- **Rule:** Treat every feed field except `title`, `link` and `date` as optional. The matcher falls back to the link's host (`x.ai`); keep that fallback when touching `itemView` in `match-news.mjs`, and add a test with an item that lacks the field.
- **Status:** active

### M-009 · A workflow was designed to open and squash-merge a PR, which Actions may not do here
- **Date:** 2026-10-05 · **Layer:** 13-ci-workflows · **Evidence:** PR #14 (first version) → PR #15 "push a squash commit instead of a PR"
- **What happened:** `model-history-auto.yml` first created a pull request; the repository setting does not allow GitHub Actions to create pull requests (and stays that way).
- **Root cause:** The design assumed a repository permission without checking it.
- **Rule:** Before designing a workflow around a GitHub capability (creating PRs, pushing to protected branches, triggering other workflows), check the repository/organisation setting. Known facts: Actions may **not** create PRs here; commits pushed with `GITHUB_TOKEN` do **not** start push workflows, so a follow-up build must be started with `workflow_dispatch` (the auto-merge workflow does this).
- **Status:** active

### M-010 · Site texts promised a human check that automation had removed
- **Date:** 2026-10-05 · **Layer:** 04-content-pages-and-site-shell, 14-new-model-automation · **Evidence:** PR #16
- **What happened:** About and Disclaimer said new Model History entries are reviewed before publication. After the cloud routine and `model-history-auto.yml` (PRs #13–#15) that was no longer true.
- **Root cause:** The automation PRs changed behaviour but not the public statements about it; the docs followed days later.
- **Rule:** A change to who or what publishes content (automation, review step, AI involvement, data sources) is a change to `about.html`, `disclaimer.html`, `privacy.html` (if data handling changes), `README.md`, `model-history/README.md` and the CHANGELOG, in the **same** PR.
- **Status:** active

### M-011 · Stale repository name in CHANGELOG comparison links after a rename
- **Date:** 2026-10-05 · **Layer:** 15-docs-licensing-release · **Evidence:** PR #17
- **What happened:** The CHANGELOG footer links still used the old repository name; GitHub redirected them, but they were wrong.
- **Root cause:** A rename was not followed by a search for the old name.
- **Rule:** After any rename (repository, domain, company), `grep -rn "<old name>"` over the whole repository, README, CHANGELOG, workflows, HTML meta tags and `feed.xml` included.
- **Status:** active

### M-012 · New GPT tier names were not detected as new models (PR #20)
- **Date:** 2026-10-27 · **Layer:** 08-model-history-news-matching, 14-new-model-automation · **Evidence:** PR #20 (merged), `NEW_NAME_RE` in `scripts/model-history/match-news.mjs`
- **What happened:** "Introducing GPT-6.1 Terra" was in the feed but no `new-model` issue was opened, so the daily cloud routine had nothing to work on.
- **Root cause:** `NEW_NAME_RE` only knew the GPT suffixes `mini|nano|pro|turbo`, so the title read as plain `gpt-6.1`. That bare name counts as *known* because the record "GPT-6.1 Sol" starts with it: prefix matching hides new variants.
- **Rule:** When a vendor introduces a new naming suffix or tier (OpenAI: Sol, Luna, Terra, Astra, Instant), extend `NEW_NAME_RE` and add a test where a sibling record already exists. After a new release shows up in the feed, check that a `new-model` issue appears within one build; if it does not, suspect the regex first. Other vendors' tier words (Claude, Gemini, Grok, Mistral, Nemotron, Command, Sonar) have the same exposure.
- **Status:** active

### M-013 · `cd` in the shell tool moved the session's working directory (three times in one session)
- **Date:** 2026-10-27 · **Layer:** process (cloud sessions) · **Evidence:** this session; three environment notices ("Primary working directory … was …")
- **What happened:** Commands like `cd assets && sed …` carried over: the next calls ran in a subfolder and the app's idea of the primary working directory changed with it. It happened again after the rule had been written down, within the same session.
- **Root cause:** In the main session `cd` persists between Bash calls, and the app can only open files inside the primary working directory. A rule that depends on remembering ("don't cd") fails under routine commands like `cd dir && sed …`.
- **Rule:** Never start a Bash command with a bare `cd <subfolder>`. Use absolute paths (`/home/user/ai-radar.eu/...`), or a subshell `( cd dir && … )`. The only allowed `cd` is back to `/home/user/ai-radar.eu`. Write deliverables inside the repository root.
- **Status:** active

---

## Known traps (constraints found in the code and docs, not yet an incident)

These are not mistakes made so far; each is a rule the code relies on. Breaking one is how the next entry above gets written. Every trap names where it is documented.

| ID | Trap | Where it is documented / enforced |
|---|---|---|
| T-01 | The post-id functions `cyrb53`, `postKey`, `postId` exist in **three** files and must be byte-identical: `scripts/model-history/lib.mjs` (reference), `scripts/build-feed.mjs`, `assets/app.js`. `ABOUT_RULES` + `aboutCompany()` must stay identical in `scripts/build-feed.mjs` and `assets/app.js`. | Comments in all three files; the first is enforced by validator code E18, the second is not enforced by anything |
| T-02 | `data.json`, `feed.xml`, `digest.json` and `img/` are written by the feed build every two hours. The build **deletes every file in `img/` that no item references** (`cacheImages` step 4): never put documentation or other files in `img/`. | `scripts/build-feed.mjs`, `.github/workflows/build-feed.yml` (it only `git add`s `feed.xml data.json img` and `digest.json`) |
| T-03 | `models/` and `sitemap-models.xml` are generated by `build.mjs` (which removes orphans in `models/`) and only committed while the repository variable `MODEL_HISTORY_PUBLISH` is `on`. `model-history/state/*.json` is machine state, append-only (`news-links.json`) or rewritten wholesale (`source-status.json`). None of these is edited by hand; to drop a news link add its post id to `news.exclude` in the record. | `model-history/README.md`, workflows |
| T-04 | Every file in the repository is public (Pages serves all of it, including `model-history/`, `state/`, `notes` fields and this file). `robots.txt` only asks crawlers to skip `/model-history/` and `/scripts/`. | `model-history/README.md`, `robots.txt` |
| T-05 | Dates keep the precision of the source: never invent a day or month (`-01`, `-15`, `-01-01`, `-07-01`). Do not copy dates from datasets that pad precision (Epoch AI stores an unknown day as the 15th). Validator warning W12 flags many day-1/15 dates. | `model-history/README.md` "Dates" |
| T-06 | Ids never change. A model id keeps the organisation of the time of entry; a renamed slug goes into `previousSlugs`, a moved route into `previousRoutes` (redirect pages are generated). Record file path = route organisation + id after the first dot. | `model-history/README.md` "Ids and slugs", validator E02/E03/E15 |
| T-07 | `archive.today` is not an allowed archive provider; archive URLs must match their provider's pattern (fixed capture, specific commit/version). Never write, compile or host replacement documentation (no PDFs/screenshots/mirrors in the repo). | `model-history/README.md` "When a source disappears", validator E10 |
| T-08 | `model-history-auto.yml` runs on every push to `claude/**`. It acts only when the **head commit message contains `[model-history]`**, and then squashes the branch onto `main`. Cloud-session branches are named `claude/…`: keep the token out of ordinary commit messages. The cloud routine's own prompt lives on claude.ai, not in this repository. | `.github/workflows/model-history-auto.yml`, `model-history/README.md` |
| T-09 | Concurrency groups: the Model History **build** job and the source-health **publish** job share `model-history-writer`; the feed build deliberately has **no** shared group (a shared group cancels a waiting run and a cancelled feed build loses a news update). `source-health` has its own per-branch group. Do not merge these groups. | Comments in the workflows |
| T-10 | Every workflow that pushes to `main` does `git pull --rebase && git push` in a retry loop. `main` moves every two hours by bots: fetch/merge before opening a PR, expect "branch behind" and never force-push `main`. | `build-feed.yml`, `model-history.yml`, `source-health.yml` |
| T-11 | Site pages share a hand-copied header/footer: `index.html`, `about.html`, `contact.html`, `privacy.html`, `disclaimer.html`, `404.html` and `page()` in `scripts/model-history/templates.mjs` ("same template as about.html"). A navigation change must be made in all of them, then `models/` is regenerated by the build. | Comments in `templates.mjs`; README rollback table (five site pages) |
| T-12 | `assets/registry.js` is a classic script that is also executed in a `node:vm` sandbox by the Model History generator and validator (E25). It must stay free of DOM access at load time and set only `window.AIRadarRegistry`. | Comment in `registry.js`, `lib.mjs` `loadRegistry` |
| T-13 | The same company data exists in three places: `assets/registry.js` (ids, hues, logos), the `FEEDS` list and `ABOUT_RULES` in `build-feed.mjs` (names must equal `registry.name`), and `model-history/organizations.json` (`radarCompanyId` must be a registry id). Adding a company touches all of them plus the card/ABOUT logic. | E25 in the validator; comments in `build-feed.mjs` |
| T-14 | The cron of the feed build (`17 */2 * * *`) is mirrored as arithmetic in `build-feed.mjs` (`nextCronSlot`) and `assets/app.js` (`nextSlot`) to drive the countdown. Change all three together. | Comments in both files and `build-feed.yml` |
| T-15 | The browser enhancement scripts contain **copies** of Model History vocabularies and helpers (`assets/models.js`: categories, lifecycle, evidence, labels, `normalize`/`fold`/`sortKey`). `explorer.test.mjs` compares them with `lib.mjs`/`derive.mjs`; a vocabulary change in `lib.mjs` needs the same edit in `models.js`. | Header of `assets/models.js`, `explorer.test.mjs` |
| T-16 | Hosts that refuse scripts: `perplexity.ai` answers 403, `substack` 403s GitHub runner IPs, `deepseek.com` **with** `www` fails the TLS handshake from the checking network (use the apex host; note it in the source's `notes`), `openai.com` and `x.ai` are Cloudflare-protected against the thum.io screenshot service. Sources that cannot be checked by script stay `unknown` until checked in a browser; unknown proves nothing and lowers the evidence status (W03). | `model-history/README.md`, PRs #11/#12, `SCREENSHOT_BLOCK` in `build-feed.mjs` |
| T-17 | Local Node is 22; CI uses Node 24 for Model History and the runner default for `build-feed.yml` (no `setup-node` there). Code must run on both; README states Node 20+ for the build script. | Workflows, README |
| T-18 | `node --test` without the quoted glob also executes `scripts/model-history/test/make-fixtures.mjs`, which **deletes and rewrites** `fixtures/basic/`. Always quote: `node --test "scripts/model-history/test/*.test.mjs"`. | `model-history/README.md` "Commands" |
| T-19 | `match-news.mjs` records `firstSeenIn` from git history and needs `fetch-depth: 50` in CI; `backfill-news.mjs` needs a **full** clone. A shallow cloud-session clone cannot run the backfill. | Workflow comment, header of `backfill-news.mjs` |
| T-20 | Browser storage keys are exactly `airadar-theme`, `airadar-motion`, `airadar-saved`. The privacy statement lists them; a new key means a privacy-page change and a migration/removal story for the old key. No third-party requests, no analytics, no web fonts: nothing may be added that breaks this. | README, `privacy.html`, `assets/app.js` |
| T-21 | The generated pages have size budgets (model page 60 KB, company page 150 KB, index 350 KB) checked by the build and tests. More data per model can break the budget at ~1000 models. | `build.mjs` `BUDGET`, `build.test.mjs` |
