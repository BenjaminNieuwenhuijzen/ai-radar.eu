# CLAUDE.md — AI Radar (ai-radar.eu)

Static site on GitHub Pages: a news dashboard for 12 AI companies plus "Model History", a source-based history of their models. Plain HTML/CSS/JS and Node built-ins only: no `package.json`, no dependencies, no build step for the dashboard.

## At the start of every session

1. Read `mistakes.md` (loaded below). It lists what already went wrong and the rules that prevent it. Do not repeat an entry.
2. Read [`docs/layers/README.md`](docs/layers/README.md) (map of the layers) and then the layer document of the part you are about to change. Each layer document lists its files, what it does on its own, what other layers rely on, and a change checklist.

@mistakes.md

## During and at the end of a session

- A defect found by CI, a reviewer, the owner or yourself, a revert, or a wrong assumption → add an entry to `mistakes.md` in the same PR as the fix (template in that file).
- You changed what a layer does, its inputs/outputs or its files → update that layer's `docs/layers/NN-*.md` (and its "Last verified" line) in the same PR. A new independent part of the system gets a new layer document and a row in `docs/layers/README.md`.
- Keep `docs/layers/` and `mistakes.md` factual: describe what the code does today, not intentions.

## Working rules

- **Language:** English for code, comments, documentation, commit messages and PRs (the repository is English throughout). Talk to the owner in the language they use.
- **Never edit generated or machine-written files by hand:** `data.json`, `feed.xml`, `digest.json`, `img/`, `models/`, `sitemap-models.xml`, `model-history/state/`. Workflows write them.
- **Privacy rules of the site are product rules:** no analytics, no cookies, no web fonts, no third-party requests; browser storage only `airadar-theme`, `airadar-motion`, `airadar-saved`.
- **Everything in the repository is public** (GitHub Pages serves it all). No secrets, no private notes.
- **No new dependencies.** Node built-ins only (Node 24 in Model History CI; the cloud sandbox has Node 22, which also passes the tests).
- Use absolute paths in shell commands; do not leave the shell in a subfolder (M-013).
- Branches: work on the branch the session names (`claude/…`). Never put `[model-history]` in a commit message (T-08). Prefer a pull request over a direct push; use `.github/pull_request_template.md` (Summary / Changes / Verification) and a label (`feature`, `fix`, `documentation`) so the release notes group it.

## Commands (repository root)

```sh
node scripts/model-history/validate.mjs                       # curated data: 0 errors expected (62 warnings at baseline)
node --test "scripts/model-history/test/*.test.mjs"           # 372 tests; keep the quotes (T-18)
node scripts/model-history/match-news.mjs --dry-run           # what the news matcher would link
node scripts/model-history/build.mjs --publish --out .preview/models --sitemap .preview/sitemap-models.xml   # local preview build (.preview/ is git-ignored)
node scripts/model-history/serve.mjs --overlay /models=.preview/models --overlay /sitemap-models.xml=.preview/sitemap-models.xml   # http://127.0.0.1:8125/
node scripts/build-feed.mjs                                   # the feed build; writes data.json/feed.xml/img/ (CI only; discard the output locally)
```

The dashboard itself has no tests; check it by serving the repository root (`serve.mjs`) and opening `/` in a browser (root-relative paths: opening `index.html` from disk does not work).
