# Contributing to Leftleg

Thanks for helping build Leftleg. This repo is developed heavily with AI agents
(the [pi coding agent](https://github.com/earendil-works/pi-mono) itself), so
the rules below are written to be followable by humans and agents alike.

## Ground rules

[`AGENTS.md`](AGENTS.md) is the authoritative instruction file — read it first.
The non-negotiables:

1. **The build gate passes, always.** `npm run build` must succeed with
   **0 svelte-check errors, 0 warnings**, all vitest tests green, and a clean
   vite build. After touching Rust framing/parsing logic, also run
   `npm run check:rust` and `npm run test:rust`.
2. **Svelte 5 syntax only** — `onclick`/`oninput` (never `on:`), runes
   (`$state`/`$derived`/`$effect`). Inside `$derived.by`, bare stores must be
   auto-subscribed with `$storeName`.
3. **pi owns agent state.** Leftleg renders pi's state; never duplicate
   sessions, model config, or message history in GUI-owned stores. GUI state
   lives only in `readGuiState`/`writeGuiState`.
4. **Errors are never silent.** Failures surface in the UI (status notes,
   banners) and in `%APPDATA%/dev.leftleg.app/logs/leftleg.log`.

## Working on the repo

```powershell
npm install
npm run tauri dev        # vite hot reload + cargo debug build
npm run build            # the gate — run before every push
```

Windows-only toolchain: Node 22+ (see `.nvmrc`), Rust stable-msvc, MSVC Build Tools.

## Pull requests

- Keep changes focused; one logical change per PR.
- Add or extend tests for behavior changes (vitest for frontend logic,
  `cargo test` for framing/parsing — both suites have real coverage to follow).
- Run `npm run build` (and, for Rust changes, the cargo checks) and paste the
  results in the PR description. CI runs the same gate on every PR and push to
  master, plus a weekly security job (npm audit + cargo audit).
- Commits use Conventional-Commits-style prefixes (`feat:`, `fix:`, `docs:`,
  `chore:`, `ci:`); AI-assisted commits carry
  `Co-Authored-By: Claude Code <noreply@anthropic.com>` in the body.
- Docs that must travel with code changes: `docs/ARCHITECTURE.md` (architecture),
  `docs/RELEASE.md` (release/update flow), `docs/ROADMAP.md` (status), and
  `CHANGELOG.md` with every version bump.

## Releases

Maintainers: follow [`docs/RELEASE.md`](docs/RELEASE.md). Bump all four
manifests + `CHANGELOG.md` per the `MAJOR.FEATURE.FIX` policy in
[`AGENTS.md`](AGENTS.md), push a `vX.Y.Z` tag — CI validates version identity,
builds the signed NSIS updater and `latest.json`, and opens a draft release;
publishing the draft is the only manual step. The manual build path in
RELEASE.md is recovery-only (CI unavailable).
