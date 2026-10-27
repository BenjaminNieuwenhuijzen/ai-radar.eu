# 13 · CI workflows (GitHub Actions)

> **Last verified:** 2026-10-27 at `f849768` · **Files:** `.github/workflows/build-feed.yml`, `model-history.yml`, `source-health.yml`, `model-history-auto.yml`, `release.yml`

## What this layer does on its own

All scheduled and event-driven work. There is no other server: the site is whatever the workflows commit to `main`. The workflows are also the **only writers** of generated files.

| Workflow | Trigger | Does | Writes to `main` |
|---|---|---|---|
| **Build combined feed** (`build-feed.yml`) | cron `17 */2 * * *`, manual | installs ImageMagick; runs `scripts/build-feed.mjs` (secret `ANTHROPIC_API_KEY` optional); commits "Update feed data" | `feed.xml`, `data.json`, `img/`, `digest.json` |
| **Model History** (`model-history.yml`) | pull request touching Model History code/data/assets; push to `main` touching them; **after every successful feed build** (`workflow_run`, main only); manual | `validate` job (all events; tests only on pull requests). `build` job (main only, group `model-history-writer`, 15 min): validate again on the branch tip → `match-news.mjs --new-names` → open `new-model` issues (layer 14) → `build.mjs` → commit "Update model history" | `model-history/state/`; plus `models/` and `sitemap-models.xml` only when variable `MODEL_HISTORY_PUBLISH` is `on` |
| **Model History source health** (`source-health.yml`) | cron `41 3 * * *`, manual | `check` job (≤ 60 min, read-only) → artifact → `publish` job (main only, group `model-history-writer`): validate, build, commit "Update model history source status" | `model-history/state/source-status.json` (+ generated pages when the gate is on) |
| **Model History auto-merge** (`model-history-auto.yml`) | push to `claude/**` | only acts when the head commit message contains `[model-history]` (layer 14) | one squash commit on `main`, then dispatches `model-history.yml` |
| **Release** (`release.yml`) | push of a tag `v*` | `gh release create --generate-notes`, appends a link to CHANGELOG.md | no commit; creates a GitHub Release |

`.github/release.yml` configures the generated release notes (excludes bot authors, groups merged PRs by label: Features `feature|enhancement`, Fixes `fix|bug`, Documentation `docs|documentation`, everything else). `.github/pull_request_template.md` (Summary / Changes / Verification) is the PR template.

## Concurrency and ordering (do not casually change)

- Both feed build and Model History build push to `main`: each ends with a retry loop `git pull --rebase && git push` (3 tries, 10 s apart) (T-10).
- The Model History **build** job and source-health's **publish** job share group `model-history-writer` (`cancel-in-progress: false`, GitHub keeps one pending run — a waiting publish may be cancelled). The feed build is deliberately **not** in that group: a shared group cancels a waiting run and a cancelled feed build loses a news update (T-09).
- `source-health` runs are serialised per branch (`source-health-<ref>`), because each run builds on the previous counters.
- `model-history-auto` has its own group `model-history-auto`.
- Commits pushed with `GITHUB_TOKEN` do not start push workflows, so the auto-merge dispatches `model-history.yml` explicitly. Actions may not create pull requests in this repository (M-009).
- Node: Model History jobs use Node 24 (`setup-node`); `build-feed.yml` uses the runner's default Node (T-17).
- Job summaries are **public**; the reports are written accordingly.

## Permissions

`build-feed`: `contents: write`. `model-history`: default `contents: read`; the build job `contents: write`, `issues: write`. `source-health`: read; publish job `contents: write`. `model-history-auto`: `contents`, `issues`, `actions: write`. `release`: `contents: write`.

## Repository settings the workflows depend on (not in the repository)

- Variable `MODEL_HISTORY_PUBLISH` = `on` (the publish gate; on since 2 October 2026).
- Secret `ANTHROPIC_API_KEY` (optional; digest).
- GitHub Pages serving `main` root; Actions allowed to push to `main` (no branch protection blocking the bot); Actions not allowed to open PRs.

## Change checklist

- Editing a workflow: remember that `.github/workflows/model-history.yml` is itself in its own `paths` filter; a PR touching it runs the validation.
- A new generated file → add it to the right workflow's `git add` list, to the README's file list and to layer 02/10 (T-02, T-03).
- New writer to `main` → add the rebase/retry loop; decide its concurrency group deliberately.
- Test a workflow change with `workflow_dispatch` on the branch where possible (the `build` jobs only write on `main`).
- Anything that makes a push to `claude/**` publish: re-read layer 14 first (T-08).

## Traps

T-02, T-03, T-08, T-09, T-10, T-17 · M-004 (verify step order), M-007, M-009
