# 06 · Model History data (curated)

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `model-history/` (`organizations.json`, `families.json`, `records/`, `sources/`, `state/`, `README.md`, `LICENSE.md`)

## What this layer is

The curated, source-backed dataset behind `/models/`: which model an organisation released, when, what changed, how models relate (successor, revision, variant, derived from) — with a source behind every claim. It is **data only**; the validator (07) judges it, the generator (10) turns it into pages. Today: **281 records** (279 full, 2 stubs), **12 organisations** (all `tracked`), **68 families**, **954 sources**.

Records per organisation: OpenAI 38 · Google 36 · Mistral 34 · Anthropic 32 · DeepSeek 23 · xAI 20 · Microsoft 20 · NVIDIA 20 · Cohere 18 · Meta 15 · Hugging Face 13 · Perplexity 12.

## Files

| Path | Kind | Writer |
|---|---|---|
| `organizations.json` | the 12 tracked companies (+ any external lab or unit): name, type, `parentId`, `radarCompanyId`, website, hue, description, former names, narrative chapters | curator |
| `families.json` | model families and nested series (`<orgId>.<name>`) | curator |
| `records/<route-org>/<id-after-first-dot>.json` | one model per file: ids, aliases, organisations, family, categories, prominence, lifecycle, dates, relations, summary, changes, capabilities, milestones, variants, news include/exclude, notes, `lastReviewedAt` | curator, or the cloud routine for **new** models (layer 14) |
| `sources/<top-level-org>.json`, `sources/shared.json` | the source register: type, title as published, URL as published, publisher, provenance, availability, `lastCheckedAt`, optional archive copy | curator |
| `state/source-status.json` | what the daily source-health check observed (layer 09) | workflow only |
| `state/news-links.json` | append-only links model ↔ AI Radar post, kept as snapshots (layer 08) | workflow only |
| `README.md` | the data rules (adding a model, ids, dates, evidence, disappearing sources, content rules, commands, workflows, rollback) — **authoritative**, this document only summarises | owner |
| `LICENSE.md` | CC BY 4.0 for the data (the MIT licence covers code only) | owner |

## Rules that make the data trustworthy (summary of `model-history/README.md`)

- A model goes in after a public announcement or demonstrable release: no rumours, leaks or code names.
- **Dates keep the source's precision**; never invent a day/month; vague dates carry a `qualifier` (T-05).
- **Every claim has `sources`** (dates, lifecycle, relations, changes, capabilities, summary, …). Empty sources only for an unknown date/lifecycle or a non-official capability, always with a note. The evidence status is **derived by the build, never typed**.
- Ids never change; renamed slugs/routes leave redirect trails (T-06).
- Gone sources stay; replacements are added as new sources with `alternativeOf`; archive copies only from allowed providers; no hosted replacement documentation (T-07).
- English, neutral, no benchmarks/rankings/superlatives; summaries in own words; claims by the organisation are attributed.
- Corrections and removal requests arrive by email; a rights holder's request sets `suppressLink: true` on the source. The model stays.
- Everything here is public (T-04).

## Who reads it

Validator (07), news matcher (08, reads aliases/excludes), source checker (09, reads the source register), generator (10), and the cloud routine (14, which also writes). The raw files are reachable on `main` whether or not the pages are published.

## Change checklist

1. Add sources first, then the record; copy URLs exactly as published; check each URL (a browser for hosts that block scripts, T-16).
2. `node scripts/model-history/validate.mjs` → fix every error, look at every new warning.
3. **`node scripts/model-history/match-news.mjs && node scripts/model-history/validate.mjs`, then `git checkout -- model-history/state`** (M-007; a new alias can link a post whose snapshot then fails).
4. Preview locally (layer 12) and open the Explorer, the company page, the model page and its timeline.
5. Pull request labelled `feature`; the Model History workflow validates and runs the tests.
6. Aliases drive news matching: default `candidate` (reported, never linked); `auto` only for distinctive versioned names; a bare family name or umbrella name gets `never`. A new tier/suffix of an existing name also needs the detector updated (M-012, layer 08).
7. Changing the vocabulary (categories, lifecycle values, evidence labels) → also `assets/models.js` (T-15).

## Traps

T-03, T-04, T-05, T-06, T-07, T-13, T-16 · M-007, M-008, M-012
