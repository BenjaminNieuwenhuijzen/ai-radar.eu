# Model History data

This folder holds the curated data behind **Model History**, the part of AI Radar that records which AI models an organisation released, when, and what changed, with a source behind every claim. The pages themselves (`/models/` on ai-radar.eu) are generated from this data by `scripts/model-history/build.mjs`. The full design is in the Model History architecture document (`MODEL_TIMELINE_ARCHITECTURE.md`, kept outside this repository); section numbers below (§) refer to it.

**Everything in this folder is public**, including `state/` and every `notes` field: GitHub Pages serves the whole repository. Never put anything here that may not be published.

## What lives where

| Path | Kind | Who writes it |
|---|---|---|
| `organizations.json` | curated: organisations (the 12 tracked companies, plus any external lab or unit) | curator only |
| `families.json` | curated: model families ("Orbit", nested series) | curator only |
| `records/<route-org>/<id-after-the-first-dot>.json` | curated: one file per model | curator only |
| `sources/<top-level-org>.json`, `sources/shared.json` | curated: the source register (one file per top-level organisation, `shared.json` for sources about several) | curator only |
| `state/source-status.json` | machine state: what the daily source-health check observed | workflows only, never edit by hand |
| `state/news-links.json` | machine state: append-only links between models and AI Radar news posts | workflows only, never edit by hand (to drop a link, add its post id to `news.exclude` in the record) |
| `models/` and `sitemap-models.xml` in the repository root | generated pages and JSON | `build.mjs` in CI only, never edit |

The GitHub workflows never write `records/`, `sources/`, `organizations.json` or `families.json`, and nothing automated ever deletes a model or a source. The one exception to "curator only" is the cloud routine that adds **new** models (see [Automatic updates](#automatic-updates-new-models)): it acts as a curator, through the same files and the same checks.

## Adding a model

1. **Check that it qualifies.** A model goes in after a public announcement by the organisation or a demonstrable release. No rumours, leaks or unannounced code names, not even in notes.
2. **Add the sources first**, to `sources/<top-level-org>.json` (a third-party source about several organisations goes in `sources/shared.json`). Per source: `id`, `type`, `title` as published, `url` exactly as published, `publisher`, `provenance` (`primary` · `archived-primary` · `secondary`), `availability` (`active` · `archived` · `unavailable` · `unknown`) and `lastCheckedAt` (the day you checked it, `YYYY-MM-DD`; required unless `unknown`). Add `publishedAt` when the source states it. An archive copy needs `archiveUrl`, `archiveProvider` and `archivedAt`.
3. **Write the record** in `records/<route-org>/`. The route organisation is the top-level parent of the primary developer, so a unit's models live under its parent. The file name is the part of the id after the first dot. Required: `schemaVersion`, `id`, `slug`, `name` (the official name at release), `organizations` (exactly one entry with `role: "developer"` and `primary: true`), `categories`, `prominence`, `lifecycle`, `dates`, `coverage` and `lastReviewedAt`. `coverage: "full"` also needs a `summary` and a released or announced date. Use `coverage: "stub"` for a model you only need as a relation target; a stub without dates needs a `dates.note`.
4. **Validate locally** and fix every error. Warnings do not block, but each one needs a look in the PR.
5. **Preview locally** (commands below) and check the pages.
6. **Open a pull request** (label `feature`). The Model History workflow validates it and runs the tests. After the merge the workflow regenerates the pages, but only while the publish gate is on.
7. **Before merging a data PR, also run the news matcher and validate again** (`node scripts/model-history/match-news.mjs && node scripts/model-history/validate.mjs`, then `git checkout -- model-history/state`). The PR check does not match news; the build on `main` does, and a new alias can link a post whose snapshot then fails validation (this broke the build once, after the data PR of 5 October 2026).

New models usually arrive on their own: see [Automatic updates](#automatic-updates-new-models).

A minimal record (fictional):

```json
{
  "schemaVersion": 1,
  "id": "example-lab.orbit-2",
  "slug": "orbit-2",
  "name": "Orbit 2",
  "aliases": [ { "text": "Orbit 2", "match": "auto" } ],
  "organizations": [ { "id": "example-lab", "role": "developer", "primary": true } ],
  "familyId": "example-lab.orbit",
  "categories": ["language"],
  "prominence": "milestone",
  "lifecycle": { "value": "available", "sources": [ { "id": "src.example-lab.orbit-2-launch" } ] },
  "dates": { "announced": null, "released": { "value": "2024-06", "sources": [ { "id": "src.example-lab.orbit-2-launch" } ] }, "deprecated": null, "retired": null },
  "summary": { "text": "Second-generation Orbit model.", "sources": [ { "id": "src.example-lab.orbit-2-launch" } ] },
  "coverage": "full",
  "lastReviewedAt": "2026-09-30"
}
```

Aliases drive the news matching. They default to `match: "candidate"` (reported, never linked). Only distinctive, versioned names get `"auto"`; a bare family name gets `"never"`. To link a post by hand, add a full snapshot to `news.include` (§22.5); to suppress a link for good, put its post id in `news.exclude`.

## Ids and slugs

| Kind | Pattern | Example |
|---|---|---|
| organisation | `^[a-z0-9]+(-[a-z0-9]+)*$` | `example-lab` |
| family, model | `<orgId>.<name>` | `example-lab.orbit-2` |
| source | `src.<orgId>.<name>` or `src.shared.<name>` | `src.example-lab.orbit-2-launch` |

- **Ids never change.** The `<orgId>` in a model id is the organisation at the time of entry. After an acquisition or reorganisation the id stays; only `organizations`, the folder and the route move, and the old path goes into `previousRoutes`.
- A slug is `[a-z0-9-]` without dots, unique within the top-level organisation: "Orbit 2.5" becomes `orbit-2-5`. A renamed slug keeps the old one in `previousSlugs`, so the old URL gets a redirect page.
- The 12 tracked companies use their AI Radar ids (`openai`, `anthropic`, `google`, …) with `coverage: "tracked"`. Any other organisation gets `coverage: "external"` and `radarCompanyId: null`; a unit gets `type: "unit"` and a `parentId`.

## Dates

- A date is `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, exactly as precise as the source. **Never invent a day or a month**: an unknown day is not `-01` or `-15`, an unknown month and day is not `-01-01` or `-07-01`; write `2024-06` or `2024` instead.
- **Never copy dates from datasets that pad precision.** Epoch AI, for example, stores an unknown day as the 15th and an unknown month and day as 1 July. Check the date in a primary source first. The validator warns (W12) when many dates fall on day 1 or 15.
- Vague dates get `qualifier: "approximate"` or `"uncertain"`. They are shown as "c. 2024" or "2024?".
- Model dates are calendar dates as the primary source gives them, with no time-zone conversion.
- When sources disagree, `value` holds the one from the strongest source; the others go into `alternatives`, each with its own sources and a `note`.

## Evidence

- Every claim has `sources`: the dates, `lifecycle`, `replacedBy`, milestone dates, relations, changes, each capability, the summary, variant dates, and an organisation's description, former names and narrative chapters (§19.1). `categories`, `familyId`, `prominence` and `basis: "editorial"` are editorial choices, not claims.
- `sources` may be empty only for an unknown date or lifecycle, or for a capability with `disclosure` other than `official`, and then always with a `note`. Text claims (summary, changes, relations, description, former names, chapters) always need a source.
- The evidence status is **derived by the build, never typed**: primary source available, archived primary source, verified through secondary sources (at least two independent publishers), or historical evidence incomplete. A source nobody ever checked (`unknown`) proves nothing.
- Capabilities: `disclosure: "official"` needs a primary source. Numbers keep the source's wording in `asStated` ("128K"). Third-party estimates are not allowed; "not disclosed" is a valid answer.

## When a source disappears (§16.5)

1. The model stays, and so does the original `url`. Nothing is deleted.
2. The source-health check marks the original as gone; its effective availability becomes `unavailable`, or `archived` if there is an `archiveUrl`.
3. Look for an official replacement (new documentation URL, the publisher's own version archive). Add it as a **new** source with `alternativeOf: "<old id>"`, keep the old one, and add the new source to the `sources` of every claim it supports. Only then does it count.
4. Otherwise record a legitimate archive copy in `archiveUrl` with `archiveProvider` and `archivedAt`, after checking that it shows the document as it was (write what you checked in `notes`). **archive.today is not allowed.** Source-health may suggest a capture; you confirm it. `archiveProvider` takes exactly one of these values, and the validator checks `archiveUrl` against its pattern:

   | `archiveProvider` | `archiveUrl` must look like |
   |---|---|
   | `internet-archive` | `https://web.archive.org/web/<14-digit timestamp>/<original url>` (a fixed capture, not `/web/*/` or `/web/2024/`) |
   | `arxiv` | `https://arxiv.org/abs/<id>v<N>`: a specific version, no query or fragment |
   | `github` | `https://github.com/<owner>/<repo>/tree/<commit sha>/…` or `…/blob/<commit sha>/…` (7-40 hex characters, not a branch name), or `https://github.com/<owner>/<repo>/releases/tag/<tag>` |
   | `huggingface` | `https://huggingface.co/<repo>/blob/<commit sha>/…` or `…/tree/<commit sha>/…` (7-40 hex characters, not `main`) |
   | `software-heritage` | `https://archive.softwareheritage.org/…` |
   | `publisher` | an `https://` URL on the same registrable domain as the source's `url`, or as the `website` of its `publisherOrgId` (else of the organisation in the source id): the publisher's own version archive |
   | `other-approved` | nothing yet: this value only works once a provider has been added to `OTHER_APPROVED` in `scripts/model-history/lib.mjs` after an explicit decision |
5. Otherwise add reliable secondary sources to the affected claims.
6. If the evidence is still incomplete, the site says so. **Never write, compile or host replacement documentation.** No PDFs, screenshots or mirrored pages in this repository, only URLs and metadata.

## Content rules (§25)

- English, neutral, factual, third person. Summaries and changes in your own words; short quotes at most.
- No benchmarks, scores, rankings, "state of the art" or superlatives. Claims by the organisation are attributed ("Example Lab describes it as…").
- The official name at release; later names become aliases.
- Retired models and vanished sources stay. Corrections go through git and update `lastReviewedAt`.
- Uncertainty stays visible: qualifiers, alternatives and incomplete evidence are never smoothed over.
- Corrections and removal requests arrive via info@ai-radar.eu; there is no form (§25.12, §37). A justified request from a rights holder sets `suppressLink: true` on the source, with the reason in `notes`. The model and the metadata stay.
- Summaries, change notes and descriptions are drafted with AI assistance from the cited sources and checked against those sources and these rules. Records added by the cloud routine are checked only by the agent itself and the automatic checks, not by a person, before they go live. The About page and the Disclaimer say so. Every text claim keeps its own sources, so a reader can check it.

## Commands

Run from the repository root (Node 24, no dependencies):

```sh
# Validate the data in this folder (or a fixture set with --data <dir>)
node scripts/model-history/validate.mjs

# Build a local preview into .preview/ (ignored by git); --publish opens the gate for this run only.
# --out is the models directory itself. Always pass --sitemap too: without it the build writes
# the tracked sitemap-models.xml in the repository root.
node scripts/model-history/build.mjs --publish --out .preview/models --sitemap .preview/sitemap-models.xml

# The same from the fictional test data (small and fast, for work on the templates)
node scripts/model-history/build.mjs --data scripts/model-history/test/fixtures/basic --publish --out .preview/models --sitemap .preview/sitemap-models.xml

# Serve the site on http://127.0.0.1:8125/ with /models/ and the sitemap taken from the preview build
node scripts/model-history/serve.mjs --overlay /models=.preview/models --overlay /sitemap-models.xml=.preview/sitemap-models.xml

# Run all Model History tests (the quoted glob matters: bare "node --test" would also run make-fixtures.mjs)
node --test "scripts/model-history/test/*.test.mjs"
```

The preview server behaves like GitHub Pages for this site: `/dir` redirects to `/dir/`, `/page` serves `page.html`, paths are case-sensitive and unknown paths get `404.html`. It listens on 127.0.0.1 only and answers only requests addressed to `127.0.0.1:<port>` or `localhost:<port>`; any other host name gets a 403.

## Workflows and the publish gate

- `.github/workflows/model-history.yml`: on a pull request it validates and runs the tests. On a push to `main`, after every successful feed build and on manual dispatch from `main` it validates, matches news, builds and commits "Update model history". Dispatched on any other branch it only validates.
- `.github/workflows/source-health.yml`: daily at 03:41 UTC and on manual dispatch. It checks sources and archive copies and commits `state/source-status.json`, on `main` only (dispatched on another branch it runs the check and the report but commits nothing). Two runs never overlap: a run started while another is still checking waits for it (concurrency group `source-health-<branch>`), because the later run must build on the earlier run's counters. Only one run can wait, so a third start cancels the waiting one. Its publish job also shares the `model-history-writer` group with the Model History build. When it is still waiting as a Model History build queues up, GitHub cancels it and that day's check is lost. The next day checks again; to recover sooner, start the workflow by hand (Actions → Model History source health → Run workflow).
- `.github/workflows/model-history-auto.yml`: publishes what the cloud routine pushes (see [Automatic updates](#automatic-updates-new-models)).
- Their reports go to the job summary, which is **public** in the Actions tab: the validator's maintenance lists (models with incomplete evidence, W03; records not reviewed for a year, W04), the news matcher's new links, candidates and **possible new models** (versioned model names in AI Radar titles that no record knows yet), and the source-health report. The possible new models also become issues (see below).
- **The publish gate** is the repository variable `MODEL_HISTORY_PUBLISH` (Settings → Secrets and variables → Actions → Variables). It has been `on` since the launch on 2 October 2026. While it is not `on`, the workflows only validate and update `state/`; they never generate or commit `models/` or `sitemap-models.xml`, so nothing new appears on ai-radar.eu/models/. The raw files in this folder are reachable on `main` either way.

## Automatic updates (new models)

New models are added without anyone running anything locally. Three parts, all in the cloud:

1. **Detection** (GitHub, every 2 hours). After each feed build, `model-history.yml` runs `match-news.mjs --new-names` and opens one issue per versioned model name in AI Radar titles that no record, variant or alias knows yet, with the label `new-model`. At most 5 new issues per run. An issue with the same title is never opened twice, also when it was closed, so closing an issue dismisses that name. To mark a name as known for good (an umbrella name, a name that is not a model), add it to the right record as an alias with `"match": "never"`.
2. **Research and writing** (a Claude routine on claude.ai, daily at 05:00 UTC, run in Anthropic's cloud; managed at claude.ai/code/routines by the repository owner). It reads the open `new-model` issues (and stops at once when there are none), handles at most 3 per run, researches each name in official sources, and either adds a record with its sources (and a family when none fits), adds an alias to an existing record, or leaves the issue open when the name is not a model or there is no official source yet. It runs the same commands as a curator (validate, tests, match-news plus validate) and pushes one commit to a branch starting with `claude/`. The head commit must contain `[model-history]` and one `Closes #<n>` line per handled issue.
3. **Publication** (`model-history-auto.yml`, on a push to `claude/**` whose head commit contains `[model-history]`). It merges the current `main` into the branch locally and requires: only `records/**`, `sources/*.json`, `families.json` and `organizations.json` changed; `validate.mjs` without errors; the tests; and `validate.mjs` again after `match-news.mjs`. When everything passes it pushes one squash commit to `main` (GitHub Actions may not open pull requests in this repository), comments on and closes the linked issues, deletes the branch and dispatches `model-history.yml`, which builds the pages. When a check fails, nothing is published: it comments on the linked issues with a link to the run (the owner gets a notification) and keeps the branch for review.

What it does **not** do: update existing records (a model that is deprecated or retired, a new successor, a vanished source beyond what source-health records) or remove anything. Those changes still go through a pull request by hand.

To pause the automation, disable the routine on claude.ai/code/routines (issues keep being opened and wait); to stop the issues as well, remove the "Open issues for possible new models" step from `model-history.yml`. A wrong automatic entry is corrected like any other record, in a pull request.

## Rolling back

| Situation | What to do |
|---|---|
| One record or source is wrong | Correct it in a pull request. With the gate on, the next build regenerates the page; a removed model disappears from `models/`. |
| An automatic entry is wrong | The same: correct or remove the record in a pull request. If the routine keeps getting a name wrong, add that name as a `"match": "never"` alias and close its issue. |
| Stop the automatic additions | Disable the routine on claude.ai/code/routines. Without it no `claude/` branch is pushed, so `model-history-auto.yml` publishes nothing. |
| Freeze the pages | Set `MODEL_HISTORY_PUBLISH` to anything other than `on`. The pages stay as they are and nothing new is published. |
| Take Model History offline | First switch the gate off (otherwise the next run generates everything again). Then, in one commit: delete `models/` and `sitemap-models.xml`, turn `sitemap.xml` back into a plain `<urlset>` of the site pages, and remove the "Model History" links from the header and footer of the five site pages. The CDN shows the old version for up to 10 minutes; remove the URLs in Search Console if needed. |
| The dashboard breaks after the merge of the foundation | `git revert` the merge commit: it moved the company registry into `assets/registry.js` and changed `index.html` and `assets/app.js`. |

## Licence

The MIT licence in `LICENSE` covers the code only. The data in this folder (the structure, the records, the relations and the text fields written for Model History) is licensed under **Creative Commons Attribution 4.0 International (CC BY 4.0)**, see `LICENSE.md` in this folder. Titles and headlines of sources and news snapshots are third-party material: they are not covered by it and remain with their respective rights holders.
