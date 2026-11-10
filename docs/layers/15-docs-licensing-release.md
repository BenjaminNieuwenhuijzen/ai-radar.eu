# 15 · Documentation, licensing and release process

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `README.md`, `CHANGELOG.md`, `LICENSE`, `model-history/README.md`, `model-history/LICENSE.md`, `.github/pull_request_template.md`, `.github/release.yml`, `.github/workflows/release.yml`; since this session also `CLAUDE.md`, `mistakes.md`, `docs/layers/`

## What this layer does on its own

Tells people (owner, contributors, agents) what the project is, how it is released, under which licence things may be reused, and what has changed. It has no runtime effect on the site, but **the public texts are promises** that other layers must keep (layer 04).

| File | Role |
|---|---|
| `README.md` | What AI Radar does (dashboard features, 12 companies + Across AI, 41 feeds), how the build works, the `data.json` fields, the optional daily briefing, Model History summary, local preview, versioning and releases, sources and disclaimer |
| `model-history/README.md` | **Authoritative data rules** for Model History: what lives where, adding a model, ids/slugs, dates, evidence, disappearing sources, content rules, commands, workflows and the publish gate, automatic updates, rolling back, licence |
| `CHANGELOG.md` | Keep-a-Changelog format, Semantic Versioning; `[Unreleased]` on top; comparison links at the bottom. Versions: 1.0.0 (2026-06-16), 2.0.0 (2026-09-30), 2.1.0 (2026-10-02) |
| `LICENSE` | MIT for the code only (not the aggregated third-party content) |
| `model-history/LICENSE.md` | CC BY 4.0 for the Model History data; titles/headlines of sources and news snapshots are third-party material and not covered |
| `.github/pull_request_template.md` | Summary / Changes / Verification |
| `.github/release.yml`, `workflows/release.yml` | release notes generated from merged PR labels; a tag `vX.Y.Z` creates the GitHub Release (layer 13) |
| `CLAUDE.md` | Agent entry point: what to read at session start, working rules, commands. Imports `mistakes.md` |
| `mistakes.md` | Incident log (`M-nnn`) and known traps (`T-nn`); consulted at the start of every session |
| `docs/layers/` | This set: one document per self-contained layer, with an index |

## Release process

Work through pull requests (labels `feature`, `fix`, `documentation`) → entries under `[Unreleased]` in `CHANGELOG.md` → when releasing, rename that block to the version and date, fix the comparison links → `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z` → the Release workflow creates the GitHub Release. Bot commits ("Update feed data", "Update model history …") are excluded from the notes.

## Known drift (checked 2026-10-27)

- `CHANGELOG.md` `[Unreleased]` says "279 models, 952 sources"; the data now has 281 records and 954 sources. The README paragraphs carry no counts for models. Numbers in docs go stale: prefer "see the validator output" over hard-coding, or date them.
- `model-history/README.md` says "Node 24"; `README.md` says "Node 20+" for the build script; local sessions run Node 22 (T-17).
- The architecture document `MODEL_TIMELINE_ARCHITECTURE.md` (the `§` references in code and README) is **outside the repository**.

## Change checklist

- User-visible feature or fix → CHANGELOG entry under `[Unreleased]` in the same PR.
- Change to automation, data sources, storage, hosting, AI involvement → README, `model-history/README.md`, About/Disclaimer/Privacy (layer 04), CHANGELOG — together (M-010).
- Rename of repository, domain or company → search the old name everywhere (M-011).
- Behaviour change in a layer → its `docs/layers/NN-*.md` and the "Last verified" line; a lesson → `mistakes.md`.
- Everything here is public (T-04).

## Traps

T-04, T-17 · M-010, M-011
