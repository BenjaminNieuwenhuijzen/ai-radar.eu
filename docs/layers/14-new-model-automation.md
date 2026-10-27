# 14 · New-model automation (detect → research → publish)

> **Last verified:** 2026-10-27 at `f849768` · **Files:** the "Open issues for possible new models" step in `.github/workflows/model-history.yml`, `.github/workflows/model-history-auto.yml`, `NEW_NAME_RE` in `scripts/model-history/match-news.mjs`, the Claude routine on claude.ai (**not in this repository**)

## What this layer does on its own

Adds **new** models to Model History without anyone running anything locally. It is the only automated writer of curated data (`records/`, `sources/`, `families.json`, `organizations.json`). Three stages in three places:

1. **Detection — GitHub, every two hours** (after each feed build). `match-news.mjs --new-names` lists versioned model names in AI Radar titles that no record, variant or alias knows (layer 08). The workflow step opens one issue per name, label `new-model` (created when missing), title `Possible new model: <name>`. At most **5 new issues per run**; an issue with the same title (open **or closed**) is never opened again, so closing an issue dismisses the name for good. Feed titles are sanitised (no `@` mentions, no markdown link brackets). The step is `continue-on-error`: it never fails the build.
2. **Research and writing — a Claude routine on claude.ai, daily 05:00 UTC** (Anthropic's cloud; managed by the repository owner at claude.ai/code/routines). It reads open `new-model` issues (stops when none), handles at most **3 per run**, researches each name in official sources and either adds a record with sources (and a family when none fits), adds an alias to an existing record, or leaves the issue open (not a model / no official source yet). It runs the curator's commands (validate, tests, match-news + validate) and pushes **one commit to a `claude/…` branch** whose message contains `[model-history]` and one `Closes #<n>` line per handled issue.
3. **Publication — `model-history-auto.yml`, on every push to `claude/**`**, but only when the head commit contains `[model-history]`. It merges current `main` into the branch locally and requires: only curated data files changed (`records/<org>/*.json`, `sources/*.json`, `families.json`, `organizations.json`); `validate.mjs` without errors; the tests; and `validate.mjs` again after `match-news.mjs`. When all pass: one **squash commit** is pushed to `main` (the commit lists the branch commits), the linked issues get a comment and are closed, the branch is deleted and `model-history.yml` is dispatched. When a check fails: nothing is published, the linked issues get a comment with the run link (the owner is notified) and the branch is kept for review.

## What it does not do

Update existing records (deprecations, retirements, new successors, vanished sources beyond what source-health records) or delete anything. Those are pull requests by hand. Entries added by the routine are checked only by the agent itself and the automatic checks — **no human reviews them before they go live**, and About/Disclaimer say so (M-010).

## Control surface

| Want to … | Do |
|---|---|
| pause the automation | disable the routine on claude.ai (issues keep opening and wait) |
| stop the issues too | remove the "Open issues for possible new models" step from `model-history.yml` |
| dismiss one name | close its issue, or add the name as an alias with `"match": "never"` to the right record |
| correct a wrong automatic entry | normal pull request on the record; if the routine keeps getting a name wrong, add a `never` alias and close the issue |
| freeze all published pages | set `MODEL_HISTORY_PUBLISH` to anything but `on` |

## What other layers rely on

- Detection quality = `NEW_NAME_RE` + `knownNames` (layer 08). A new naming scheme that the regex does not know produces **no issue**, and nothing else notices (M-012).
- The squash-to-`main` design exists because Actions may not open PRs here (M-009).
- Layer 13: `[model-history]` is a trigger word. Any commit on a `claude/**` branch with that token is published automatically after checks (T-08). Ordinary cloud-session branches are also called `claude/…`: keep the token out of their commit messages.
- The routine's prompt/instructions live on claude.ai, not in git. If the data rules in `model-history/README.md` change, the routine's instructions need the same change by the owner, and this document should say so in "Last verified".

## Change checklist

- Changing what the auto-merge accepts → check the file regex in the "Only curated data files changed" step and the test/validate steps; keep the post-matching validation (M-007).
- Changing the issue text or label → also this document and `model-history/README.md`.
- After a release shows up in the feed, confirm a `new-model` issue appears within one build; if not, check the regex first (M-012).

## Traps

T-08, T-09 · M-007, M-009, M-010, M-012
