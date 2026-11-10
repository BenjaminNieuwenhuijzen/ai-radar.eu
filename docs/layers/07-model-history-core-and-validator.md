# 07 · Model History core library and validator

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `scripts/model-history/lib.mjs` (250 lines), `derive.mjs` (205), `validate.mjs` (1 015), `schema/*.schema.json` (4 files)

## What this layer does on its own

Defines what valid Model History data *is* and derives facts from it. `lib.mjs` and `derive.mjs` are pure helper modules imported by every other Model History script; `validate.mjs` is the gate that blocks bad data in pull requests, in the main build and in the cloud-routine auto-merge.

## `lib.mjs` — shared vocabulary and helpers

Node built-ins only. Sections: constants & vocabularies · ids · dates · text · news ids · archive allowlist · JSON loading · registry.

- `VOCAB` (categories, lifecycle values, relation types, source types, provenance, availability, archive providers, alias match modes, …), `LIMITS` (text lengths), `RE` (id patterns: `<orgId>`, `<orgId>.<name>`, `src.<orgId|shared>.<name>`, slugs, base-36 post ids).
- **Dates:** `parseDate` accepts `YYYY`, `YYYY-MM`, `YYYY-MM-DD` and validates the calendar; `interval`, `contradictory`, `sortKey`, `formatDate` (never shows a component the value lacks), `toInstant`.
- **Text:** `normalize` (NFKC, all dashes → `-`, lower-case), `fold`, `compact`, `escapeHtml`, `hasHtml`.
- **News ids:** `cyrb53`, `postKey`, `postId` — the **reference copy** of the functions that also live in `scripts/build-feed.mjs` and `assets/app.js` (T-01).
- **Archive allowlist:** `ARCHIVE_RULES` per provider (fixed captures only); `OTHER_APPROVED` is empty on purpose; archive.today is not allowed.
- **Loading:** `loadDataset(root)` reads organisations, families, records, sources and state into one object (`parseErrors` collects unreadable files so the validator can report all of them); `loadRegistry(repoRoot)` runs `assets/registry.js` inside `node:vm` (T-12).

## `derive.mjs` — derivations (pure, nothing is written)

- `buildIndex(ds)`: lookups by id, `topOrg`, `primaryDev`, `routeOrg`, `unitsOf`.
- **Claims:** `modelClaims(m)` / `orgClaims(o)` — the normative list of everything that needs sources (dates, lifecycle, `replacedBy`, milestones, relations, changes, capabilities, features, summary, variants, organisation description, former names, chapters).
- **Availability and provenance:** `effAvail` / `effProv` combine the curator's value with the machine observation in `state/source-status.json` (a source the checker declared gone becomes `unavailable`, or `archived` with an `archiveUrl`).
- **Evidence:** `claimEvidence` / `modelEvidence` → one of `primary-source`, `archived-primary-source`, `secondary-sources` (≥ 2 independent publishers, `SECONDARY_MIN`), `insufficient-evidence`. Derived, never typed.
- **Graph:** `relationEdges`, `findCycle`, `deriveGraph` (predecessors/successors/derivations across organisations); **timeline helpers** `timelineDate`, `modelSortKey`, `yearOf`.

## `schema/*.schema.json`

JSON Schema (2020-12) documents for `model`, `family`, `organization`, `source`. They document the structure **for editors only**; no schema library is used (it would need a `package.json`). `validate.mjs` is the authority.

## `validate.mjs` — the validator

`node scripts/model-history/validate.mjs [--data <dir>] [--repo <dir>] [--registry <path>|--no-registry] [--json]`. Exit code 1 when there is at least one **error**. `build.mjs` and the tests call `validate()` directly.

- **Errors E01–E29** block everything: structure, ids/slugs, references, cycles, dates (format and contradictory order), claims without sources, provenance/availability consistency, archive URL patterns, https/credentials, vocabulary, capability disclosure, HTML/text length, record path ↔ route + id, variants, news snapshots (E17), id-function copies byte-identical (E18), coverage rules, relation rules, developer entry (E24), registry consistency (E25), forbidden aspect/direction pairs, `suppressLink` reason, promoted variants, and a guard that `design/` previews never reach `main` (E29).
- **Warnings W01–W18** do not block but each new one needs a look in the PR: ambiguous aliases (W01, 47 today by design — `candidate` aliases), weak evidence (W03, 15 today), reviews older than 12 months (W04), unused sources (W05), benchmark/marketing wording (W08), many dates on day 1/15 (W12, padded-precision smell), http URLs, round numbers without `asStated`, news ids that differ from `data.json` (W18), …
- The full code list with one line each is the `CODES` object at the top of the file; the tests check that every code has a case.
- With `GITHUB_STEP_SUMMARY` set it appends the maintenance lists (models with incomplete evidence, stale reviews) to the job summary (public).
- Baseline 2026-10-27: **0 errors, 62 warnings** (281 models, 12 organisations, 68 families, 954 sources; W01 47, W03 15).

## What other layers rely on

- Every Model History script imports `lib.mjs`; changing `normalize`, date helpers or `RE` changes news matching, search (the browser copy in `assets/models.js`, T-15), sorting and page output.
- Validation order in the build: `validate` → `match-news` → `validate` again (M-007).
- The spec numbers in comments (§19.1, §22.2, …) refer to `MODEL_TIMELINE_ARCHITECTURE.md`, which is **kept outside this repository**; the rules that matter are repeated in `model-history/README.md` and in the code comments.

## Change checklist

- New field or vocabulary value: `lib.mjs` (`VOCAB`/`LIMITS`) + `schema/*.json` + `validate.mjs` + a case in `test/fixtures/validator-cases/cases.json` + `assets/models.js` if the Explorer shows it (T-15).
- New rule: give it a code in `CODES`, a negative test case, and say in the README whether it blocks.
- Tightening a rule can fail the existing 281 records: run the validator over real data before pushing, then the news step (M-007).
- Never import from `templates.mjs`/`build.mjs` here; dependency direction is lib → derive → everything else.

## Commands

```sh
node scripts/model-history/validate.mjs
node scripts/model-history/validate.mjs --json
node --test scripts/model-history/test/lib-derive.test.mjs scripts/model-history/test/validate.test.mjs
```

## Traps

T-01, T-05, T-06, T-07, T-12, T-15 · M-007, M-008
