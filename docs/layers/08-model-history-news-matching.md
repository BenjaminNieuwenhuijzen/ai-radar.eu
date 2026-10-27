# 08 · Model History news matching and new-model detection

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `scripts/model-history/match-news.mjs` (428 lines), `scripts/model-history/backfill-news.mjs` (153), `model-history/state/news-links.json`

## What this layer does on its own

After every feed build it reads `data.json` (never writes it), links AI Radar posts to model records, and reports model names that no record knows yet. It runs inside the Model History build job (layer 13) and also standalone.

### 1 · Linking posts to models

- **Aliases decide whether a link is made.** Each record (and inline variant) lists aliases with `match`: `auto` (creates a link), `candidate` (the default; reported, never linked), `never` (ignored). Only an explicit `auto` links.
- Matching runs on the normalised title + summary (`normalize`: NFKC, dashes unified, lower-case). A hit needs a word boundary on the left and **not** a longer name/version on the right (`orbit 2` does not match `orbit 2.5`, `orbit 2x`, `orbit 2-vision`). On overlap the longest alias wins; identical spans from two models stay (validator W01) and each model follows its own `match`.
- `news.exclude` (post ids in the record) always wins; `news.include` holds hand-made snapshots.
- The stored relation is the pair (`modelId`, `postId`) with a **snapshot** (link, title, `publishedAt`, `dateOnly`, company, source, method, alias, `firstSeenAt`, `firstSeenIn`). Links are **append-only** and survive the post leaving `data.json`. Field order is fixed so diffs stay small.
- Google News titles are split into title + outlet the way the dashboard does; a feed item without `source` (xAI) gets the link's host (M-008).
- **Guards:** fewer than `MIN_ITEMS` = 100 feed items → the run is skipped with exit 0 (a broken feed build is not this script's failure); a broken state file or unparseable dataset → exit 1 and nothing written (overwriting would drop every link).
- Output: `model-history/state/news-links.json` (only rewritten on a content change) and a capped report on stdout and in the job summary (public).

### 2 · Possible new models (`--new-names <file>`)

`NEW_NAME_RE` recognises versioned model names of the tracked families in feed titles (GPT incl. tier suffixes `mini|nano|pro|turbo|instant|sol|luna|terra|astra`, o-series, gpt-oss, Claude, Gemini, Gemma, Llama, Grok, Mistral family, DeepSeek, Phi, Nemotron, Command, Aya, Sonar, SmolLM/SmolVLM). A name is *known* when a record name, variant name or alias (any `match` value, `never` too) equals it or **starts with it at a word boundary** (`gemini 2.5` is known from `gemini 2.5 pro`). Unknown names are written as JSON for the workflow that opens `new-model` issues (layer 14).

- The prefix rule is also the weak spot: a new tier of a known base name looks known until the regex learns the suffix (M-012).

### 3 · Backfill (`backfill-news.mjs`, manual, local)

One-off: walks the git history of `data.json` oldest to newest and applies the same matcher and guard to each snapshot to fill `firstSeenAt` / `firstSeenIn`. Needs a **full** clone (T-19); read-only on git; `--refresh-first-seen` only lowers those two fields of existing links. Results go in by pull request. Snapshots from before 30 September 2026 have no ids, so ids are computed from the link.

## What other layers rely on

- The state file schema (validated by layer 07, rule E17 for snapshots, W18 for ids that differ from `data.json`).
- The generator (10) reads `news-links.json` plus `news.include − news.exclude` per record and merges the same story under two post ids when titles match within 2 days.
- The workflow commits `model-history/state` after every build (even when the publish gate is off).
- The post-id functions are the same as the feed build's (T-01); a different hash would orphan every stored link.

## Change checklist

- New alias semantics or regex change → tests in `match-news.test.mjs` (31) including a sibling-record case (M-012) and a missing-field case (M-008).
- New vendor/tier naming → extend `NEW_NAME_RE`; then run `node scripts/model-history/match-news.mjs --dry-run --new-names /tmp/names.json` against the current `data.json` and read the output.
- Never edit `news-links.json` by hand: to drop a link add the post id to `news.exclude` in the record (T-03).
- Always follow a data change with `match-news` + `validate` (M-007).

## Commands

```sh
node scripts/model-history/match-news.mjs --dry-run                  # report only, writes nothing
node scripts/model-history/match-news.mjs --new-names "$TMPDIR/n.json"
node --test scripts/model-history/test/match-news.test.mjs
git checkout -- model-history/state                                  # after a local run, discard the state change
```

## Traps

T-01, T-03, T-19 · M-007, M-008, M-012
