# Agent playbook — executing repo work step-by-step

This is the how-to for agent sessions doing work in Leftleg. It points at the
authoritative docs instead of restating them; every recipe below cites the rule
it enforces. Line numbers were current at v0.6.2 (2026-09-18) — treat them as
search hints, not contracts, and re-grep when a file has moved.

## 1. Read-first and invariants

Read these before touching code. They are short.

- [`AGENTS.md`](../AGENTS.md) — the authoritative rule file. Rules 1–7:
  1. **The gate** — `npm run build` after any frontend change;
     `npm run check:rust` after any Rust change (`test:rust` too when
     framing/parsing moved); `npm run tauri build` only for releases.
     Bites: every recipe in §4 ends at a gate run (§3).
  2. **Svelte 5 syntax only** — `onclick`, never `on:`; runes; inside
     `$derived.by` always `$storeName`.
     Bites: §4.2 component recipe.
  3. **Tauri capabilities are explicit** — a new plugin without a permission
     entry in `src-tauri/capabilities/default.json` fails silently.
     Bites: §4.4 Rust command recipe. (Rule 3's inline list of granted
     permissions is behind the file — check `default.json` for the current set.)
  4. **`fn`, not `pub fn`, for commands in `lib.rs` root** — `pub` +
     `#[tauri::command]` at crate root collides with `#[macro_export]` (E0255).
     Bites: §4.4.
  5. **Errors are never silent** — surface in the UI and in
     `%APPDATA%/dev.leftleg.app/logs/leftleg.log`.
     Bites: §4.1/§4.3 (`transientNote`), §8 debug loop.
  6. **pi owns agent state** — GUI persists only GUI state via
     `readGuiState`/`writeGuiState`; never messages, sessions, or model config.
     Bites: §4.1 store-first flow.
  7. Default model for this machine's stack (`openrouter/z-ai/glm-5.3-flash`).
     Bites: configuration work only.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — ground rules 1–4 mirror AGENTS.md
  rules 1/2/6/5. Adds the commit conventions: Conventional-Commits prefixes
  (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`) and the
  `Co-Authored-By: Claude Code <noreply@anthropic.com>` trailer on AI-assisted
  commits. Bites: every commit you make.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the why behind the request-correlation
  discipline (§4.1): stale responses must not update the newly selected view;
  surfaces are per-project, in-memory, never on disk.
- [`AUDIT-2026-09-17.md`](AUDIT-2026-09-17.md) — the worked example for §6/§7
  (parallel review, fix rounds, convergence).
- [`GAP-ANALYSIS.md`](GAP-ANALYSIS.md) / [`ROADMAP.md`](ROADMAP.md) — what's
  next and what's shipped; check before proposing work so you don't duplicate a
  parked item or violate a non-goal.
- [`docs/RELEASE.md`](RELEASE.md) — release checklist; §9 here is link-only.

Non-negotiables, compressed: gate always green (0 errors / 0 warnings, tests
passing); pi owns the brain, Leftleg owns the desk; no silent failures.

## 2. Repo map with anchors

Native (`src-tauri/src/`):

- `lib.rs` (~683 lines) — RPC lifecycle commands
  (`pi_start/stop/status/request/send`), update-shutdown gate, tray, log
  append. The `invoke_handler` registration at `lib.rs:588-616` **is** the
  full command list.
- `pi.rs` — RPC bridge: spawn, JSONL framing (split on `\n`, strip `\r`),
  request correlation, `pi-event` forwarding.
- `pimgr.rs` — pi update manager (`run_pi_manager`, `pi_integrity_report`);
  single-flight via a native flag.
- `sessions.rs` — session listing (JSONL header parse), GUI-state persistence,
  base64 attachment reads, artifacts/git/repo-file commands, `open_path`
  containment, validated project-folder creation (`create_project_dir` at
  `:1090`, validator `create_project_dir_checked` at `:1107`, `mod tests` at
  `:1141`).
- `src-tauri/capabilities/default.json` — the explicit permission grants
  (currently `core:default`, `dialog:default`, `opener:allow-open-url`,
  `opener:allow-default-urls`, `updater:default`, `process:default`, plus
  `core:window:allow-*` for the custom title bar).

Frontend (`src/`):

- `src/lib/stores.ts` (~1830 lines) — central state: event handling, UI item
  assembly, all agent actions. Anchors: `openRightPanel` `:42`,
  `setSessionStatus` `:317`, `collectUpdateInstallBlockers` `:358`,
  `transientNote` `:615`, `requestForView` `:959`, `sendPrompt` `:1029`,
  `goHome` `:1254`. The file is large **on purpose** — the split threshold is
  ~3000 lines and stores.ts headroom is deliberate; do not reorganize it
  opportunistically (see §10).
- `src/lib/api.ts` (~250 lines) — typed `invoke` wrappers (`piRequest`,
  `readGuiState`/`writeGuiState`, `pickAttachments`, `openPathLocal`, …).
  Every new command gets a wrapper here.
- `src/lib/types.ts` (~240 lines) — RPC protocol mirrors. pi event/command
  shapes land here first.
- `src/lib/keybindings.ts` (~155 lines) — pure, store-free accelerator
  registry (`ACTIONS` `:19`, `matchKeybinding` `:107`, `parseCapture` `:125`,
  `conflictingAction` `:140`).
- `src/lib/composer-drafts.ts` — composer draft store keyed `project:session`.
- `src/lib/sidebar-model.ts` — sidebar section/pin model.
- Other tested helpers: `errors.ts`, `markdown.ts`, `scroll-spy.ts`,
  `thinking.ts`, `time-format.ts`, `files-model.ts`, `pi-update.ts`,
  `updater.ts`.
- `src/lib/settings/` — `mgmt.ts` (settings-companion transport), `state.ts`;
  tests: `mgmt.test.ts`, `companion.test.ts`, `companion.safety.test.ts`,
  `companion.integration.test.ts` (needs a real `pi` binary — see §3).
- `src/lib/test/` — `fake-pi.ts` (deterministic fake `pi --mode rpc`),
  `fake-pi-hub.ts` (multi-project hub, pid-tagged envelopes), `fixtures.ts`
  (recorded protocol shapes).
- `src/components/` — TitleBar, Sidebar, PromptRail, Chat, MessageView,
  ToolCard, Composer, RightPanel (+ DiffPanel/FilesPanel/Artifacts),
  StatusBar, SettingsModal, ExtDialog, NewProjectCard, ProjectSettingsCard,
  FileCard, ContextMenu, Notifications, SessionRow, StartScreen, StatusCard,
  ProjectIcon. `src/components/settings/` — SettingsWorkspace, PackageForms.
- `companion/leftleg-settings/index.ts` — settings-management bridge
  extension (reserved `settings-mgmt` command, `LeftlegMgmt:` notify marker,
  revision-checked atomic writes).
- `companion/leftleg-media/index.ts` — `image_generate` tool extension
  (OpenRouter image API, credential via pi's model registry, project-scoped
  `.pi/images/`).
- `vitest.config.ts` — jsdom environment + Svelte browser conditions so
  `mount()` works in tests.
- `vite.config.ts` — `__APP_VERSION__` injected from `tauri.conf.json`
  (the canonical version).

## 3. Gates

| Command                     | Runs                                                              | Catches                                                 | When required                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`             | `svelte-check` + `vitest run` + `vite build`                      | template/type errors, broken tests, prod-build breakage | after **any** frontend change (AGENTS.md rule 1). Must be **0 errors AND 0 warnings**, tests green, clean vite build — treat a warning as a failure even if the tool would let it pass |
| `npm run verify:functional` | full frontend gate + locked Rust tests                            | cross-stack behavioral regressions                      | before handing off a mixed frontend/Rust change                                                                                                                                        |
| `npm run verify`            | Prettier + ESLint + frontend gate + rustfmt + Clippy + Rust tests | hygiene, unsafe promise use, and behavioral regressions | target whole-repository gate; hygiene remains advisory until the baseline described in `docs/CI.md` is cleared                                                                         |
| `npm run check`             | `svelte-check` only                                               | types/templates, fast                                   | between edits while iterating                                                                                                                                                          |
| `npm test`                  | `vitest run`                                                      | logic regressions                                       | same, test-only                                                                                                                                                                        |
| `npm run check:rust`        | `cargo check`                                                     | Rust compile errors                                     | after **any** Rust change                                                                                                                                                              |
| `npm run test:rust`         | `cargo test`                                                      | framing/parsing/containment regressions                 | when framing/parsing/file-safety logic moved                                                                                                                                           |
| `npm run tauri build`       | full signed release bundle                                        | —                                                       | release only (§9)                                                                                                                                                                      |

CI (`.github/workflows/ci.yml`) splits the gate into named jobs on every PR/push to master:

- **Windows runner + Node 22.**
- **Frontend** runs Svelte checks, 308 non-Pi tests, and the production build.
- **Pi contract** installs pi 0.85.1 globally — `companion.integration.test.ts` spawns a
  real `pi --mode rpc` from PATH (`cmd /C pi --mode rpc`, PI_OFFLINE=1), so
  the complete local suite (and therefore `npm run build`) needs a real pi
  binary locally too, not just mocks.
- **Rust tests** uses the pinned compiler and `cargo test --locked`.
- **Required quality gate** aggregates the three functional results and is the
  stable branch-protection check.
- Frontend/Rust hygiene, declared-minimum-Rust compatibility, and coverage are
  advisory during the documented baseline cleanup; see `docs/CI.md`.
- A weekly security job runs `npm audit` (fails on high/critical) and
  `cargo audit`; accepted risks are recorded in `.cargo/audit.toml` /
  `docs/AUDIT-2026-09-17.md`.

Run **one gate at a time** — parallel agents running builds in the same tree
collide (§10).

## 4. Task recipes

### 4.1 Add a frontend feature (store-first flow)

1. Design the action in `stores.ts` using `sendPrompt` (`:1029`) as the
   template: **guard → capture origin → act → patch surface**.
   - _Guard:_ `updateInstallLock`, `navigating`, connected + open project.
     Never act with no view to act on.
   - _Capture origin:_ `originProject` / `originProc` / `originRevision` at
     the moment the action starts.
   - _Act:_ view-bound requests go through `requestForView` (`:959`) —
     **never a bare `api.piRequest`** for view-updating work. The start-view
     trap: with no open project, a `project || null` fallback routes to
     Rust's active-process pointer and silently mutates a background project
     left running by `goHome`; `requestForView` throws instead
     (`:961-964`). The pin is `stores.test.ts:489` ("requestForView-routed
     actions cannot reach the background project at home") — the canonical
     warning. `sendPrompt` is the deliberate exception: it captures origin
     itself and drives its own delivery patches onto the owning surface
     (foreground or background), because the optimistic bubble must update
     even if focus changed.
   - _Patch surface:_ update only the project that owns the response. A stale
     response (project/proc/revision moved) is dead on arrival —
     `requestForView` throws `VIEW_CHANGED_MSG` (`:951`), which callers may
     swallow silently because staleness is expected, not a failure
     (AGENTS.md rule 5 does not apply to it).
2. Add protocol shapes to `types.ts`.
3. Persistence only via `api.readGuiState`/`writeGuiState`
   (AGENTS.md rule 6). Messages, sessions, model config: never.
4. Tests:
   - unit behavior in `stores.test.ts` (module mock of `./api` at `:5-18` —
     **grow it** when `api.ts` grows; `resetStores` at `:39-56`);
   - race pins in `lifecycle.test.ts`;
   - end-to-end journeys in `rpc-acceptance.test.ts` (FakePiHub; note the
     `matchMedia` shim at `:133-138` — new browser globals need jsdom
     shims, §10).
5. Canonical worked examples: the start-view panel collapse
   (`homePanelCollapsed` default-not-lock + `openRightPanel`, pinned at
   `stores.test.ts:499-509`) and the update-lock feature
   (`collectUpdateInstallBlockers` `:358` reporting background work and
   unsent drafts, `stores.test.ts` "update install safety" block).

### 4.2 Add a component + test

1. Svelte 5 runes only (AGENTS.md rule 2): `onclick`/`oninput`,
   `$state`/`$derived`/`$derived.by` (auto-subscribe with `$storeName` inside
   `$derived.by`), `$effect` with `untrack` for one-shot reads (see
   `Composer.svelte:17`, `StartScreen.svelte:19`, `ProjectSettingsCard.svelte:32`).
2. Window-level `keydown` (Esc) handlers follow the ladder:
   `if (e.defaultPrevented) return;`
   → a store gate for layers that outrank you but registered later
   (`$extDialog`, and the z-150 cards where relevant)
   → `e.preventDefault()`
   → close.
   Canonical: `SettingsModal.svelte` `onKeydown` (`:33-38`) and `Sidebar.svelte`
   scope popover (`onScopeWindowKeydown`, `:89-99`). One key press closes
   exactly one layer.
3. z-index tiers (verified values — a new overlay joins BOTH the right tier
   and the Esc ladder):
   - `1` — sticky headers (`DiffPanel.svelte:111`, `FilesPanel.svelte:189`,
     `FileCard.svelte:199` sticky column)
   - `5` — side panels (`RightPanel.svelte:101`, `Sidebar.svelte:924`)
   - `30` — Composer (`Composer.svelte:401`)
   - `50` — Sidebar scope popover (`Sidebar.svelte:780`)
   - `60` — TitleBar menus (`TitleBar.svelte:374`), toasts
     (`Notifications.svelte:33`), sidebar menu (`Sidebar.svelte:971`)
   - `90` — FileCard (`FileCard.svelte:153`), StatusBar model picker
     (`StatusBar.svelte:353`)
   - `100` — Settings modal (`SettingsModal.svelte:81`), context menu
     (`ContextMenu.svelte:71`)
   - `150` — NewProjectCard (`:146`), ProjectSettingsCard (`:197`),
     TitleBar About card (`TitleBar.svelte:426`)
   - `200` — ExtDialog (`ExtDialog.svelte:102`)
4. Mount-test scaffold: `StartScreen.test.ts` —
   `vi.hoisted` mocks (`:5-12`),
   `vi.mock(..., importOriginal)` spread to keep real stores (`:16-24`),
   `settle()` (`:32-35`: macrotask + `flushSync`),
   real input events (`typeDraft` dispatches a bubbling `input` event, no
   simulated shortcuts),
   held-promise determinism (a manually-resolved `switchToProject` promise
   to freeze mid-flight).
   If the component uses `fade`, mock `svelte/transition` (`:14`).

### 4.3 Add a store action

Same as §4.1, plus:

- Surfaced errors go through `transientNote` (`:615`) — user-visible, timed,
  filtered from the status line for stale-view noise (AGENTS.md rule 5 /
  CONTRIBUTING ground rule 4). Nothing fails into a bare `catch` with no UI
  trace; ignore only what is _expected_ (e.g. `VIEW_CHANGED_MSG`), and say
  so in a comment.
- Per-session UI state (chips, working/idle) goes through `setSessionStatus`
  (`:317`) so every session row renders its own cue from the same store the
  pills read.

### 4.4 Add a Rust command

1. `#[tauri::command] async fn` in `lib.rs` root — `fn`, not `pub fn`
   (AGENTS.md rule 4, E0255). Commands in submodules (`sessions.rs`, `pi.rs`,
   `pimgr.rs`) **are** `pub`.
2. Blocking work (file I/O, process spawn, scan) goes in `spawn_blocking` —
   non-async commands run on the main thread (the audit found and fixed
   exactly this; do not regress it). Every command in `sessions.rs` follows
   the pattern.
3. Register in `invoke_handler` (`lib.rs:588-616`) — this list is the source
   of truth for what the webview can call.
4. Add the typed wrapper in `api.ts` and keep the frontend module mocks in
   sync (§10).
5. Any file read/open path gets a capability + containment check:
   `open_path`'s containment (live project dirs ∪ agent dir ∪ app data dir)
   and `pick_and_read_files` (dialog + read in one native op) are the
   templates. Never reintroduce a webview-supplied path→bytes command.
6. Name/path validation: copy `create_project_dir_checked`
   (`sessions.rs:1107`) — reserved Windows device names, length caps,
   separator/wildcard/control-char rejection, idempotent open of an
   existing dir.
7. Framing-adjacent logic (JSONL classification, correlation, header
   parsing, path validation) gets a `mod tests` (`sessions.rs:1141` is the
   example) and a `npm run test:rust` run.
8. New Tauri plugin → permission entry in
   `src-tauri/capabilities/default.json` or its invokes **silently** fail
   (AGENTS.md rule 3). When a new `invoke` returns `undefined`, check this
   file first (§10).

### 4.5 Add a keybinding

1. `keybindings.ts` is a pure registry, deliberately store-free: add the
   `ActionId` to the union and an `ActionDef` row to `ACTIONS` (`:19`, with
   `defaultBinding: null` for listed-but-unbound).
2. TitleBar dispatches via `matchKeybinding` and stands down while a modal
   owns the keyboard (`TitleBar.svelte:90-91`: `defaultPrevented` +
   `$settingsOpen`/`$extDialog`/`$projectSettingsDir`/`$newProjectOpen`/
   `$aboutOpen` gate), then `preventDefault()` and dispatch the action.
3. The capture UI + duplicate warning live in `SettingsWorkspace`
   (`parseCapture` at `:445`, `conflictingAction` at `:452`) — duplicates
   are refused **by naming the action that owns them**.
4. Escape stays reserved for cancel: `parseCapture` returns null for it
   (`:127`).
5. Tests: `keybindings.test.ts` (registry) + `SettingsWorkspace.test.ts`
   (capture flow).

### 4.6 Add a setting

1. Transport is `settings/mgmt.ts`: the reserved command
   `MGMT_COMMAND = "settings-mgmt"` + notify marker
   `MGMT_MARKER = "LeftlegMgmt:"` (`:33-34`), 15 s timeout
   (`MGMT_TIMEOUT_MS`, `:35`), target probing that fails **closed** (an
   unresolved/failing agent-dir lookup denies the request and retries on
   the next one). Requests bind to a project/generation and observe both
   the RPC ack and the notify reply.
2. The form UI lives in `PackageForms.svelte`; non-finite numbers are
   rejected at every number field (NaN must never reach a settings write).
3. Mock factories: `SettingsWorkspace.test.ts` mocks the
   `../../lib/settings/mgmt` module wholesale (the scaffold all component
   tests copy); `SettingsForms.test.ts` implements the JSON-RPC boundary
   for real — `read`/`write` ops, revision conflicts thrown as
   `"conflict"`, `applyMerge`/`applyNamespaces` from the companion,
   `unsetKeys` handling. Copy that factory for any new form test.
4. Flush with `untilSent()` (`mgmt.test.ts:19`), not fixed ticks — added
   awaits must not be able to silently break the mgmt suite (an accepted
   NOTE from the 2026-09-17 audit, made structural).

### 4.7 Fix a bug

1. **Regression test first** — repo convention: nearly every fix commit
   pins its bug. Explicit `regression:` pins live at `stores.test.ts:150`
   and `mgmt.test.ts:85`; `SettingsWorkspace.test.ts` / `StatusCard.test.ts`
   pin their bugs descriptively (e.g. stale-response and owner-change
   guards). Reproduce the failure mode in a test before touching the fix.
2. Fix it, and **keep the comment explaining the failure mode** — the
   codebase's inline comments are the institutional memory of every race
   and trap (see `requestForView`'s home-view comment, `stores.ts:961-964`).
3. Run the full gate (`npm run build`; `npm run check:rust` + `test:rust`
   for Rust changes).

## 5. Test scaffold reference

One line each — open the file and copy its shape:

- `src/lib/stores.test.ts` — store unit tests; `./api` module mock `:5-18`,
  `resetStores` `:39-56`; the home-view guard pin `:489` and the
  `regression:` pin `:150`.
- `src/components/StartScreen.test.ts` — component mount + `settle()`;
  `vi.hoisted` + `importOriginal` spread; real input events; held-promise
  determinism; `svelte/transition` mock.
- `src/components/settings/SettingsWorkspace.test.ts` +
  `SettingsForms.test.ts` — the mgmt-module mock factory and the JSON-RPC
  write mock with revision conflicts, respectively.
- `src/components/StatusCard.test.ts` — owner-change / stale-response
  guards (the card closes and invalidates when its project/session/process
  changes).
- `src/components/esc-ladder.test.ts` — multi-component Esc harness mounting
  the always-on surfaces in `App.svelte`'s registration order; Esc
  dispatched **cancelable** so `preventDefault` stand-downs are observable.
- `src/lib/rpc-acceptance.test.ts` — journey tests over the real `api` seam
  with `FakePiHub` (`src/test/fake-pi-hub.ts` over `fake-pi.ts` +
  `fixtures.ts`); `matchMedia` shim `:133-138`.
- `src/lib/lifecycle.test.ts` — minimal-mock race pins (`piRequest` as
  manually-resolved promises; delayed/stale snapshots, dialog targeting,
  late events after process death).
- `src/lib/settings/companion.integration.test.ts` — real `pi --mode rpc`
  in an isolated temp agent dir; needs the global pi install (§3).

## 6. Parallel-agent discipline

Codified from the 2026-09-17 audit and the later hunt rounds:

- **Hunters are REPORT-ONLY** — they never edit. Findings come back as
  text; the lead triages.
- **Agents get disjoint file sets.** Frontend/core, components, companion,
  and native are naturally disjoint review lanes (that's how the audit
  split fe-core / components / companion / pi-surface).
- **The lead owns triage and fixes** — directly or via bounded fix agents
  with an explicit file list. A fix agent never expands scope.
- **One commit per hunt round**, prefixed
  `fix: round-N hunt findings — …` (later rounds:
  `fix: round-N audit closers — …`). The body groups findings by subsystem
  and names the pinning tests. See `3cb6793`, `1a2721f`, `9359a28`,
  `8a29993`, `86c780a` in `git log`.
- **The next round re-audits the previous round's fix commit** — fresh eyes
  on the diff, not the whole tree.
- **Convergence = a fresh round finds nothing new** → stop, record residual
  NOTEs as accepted limitations (AUDIT-2026-09-17 round 4: "The loop
  terminates here"; `86c780a`: "Hunt loop closes here").
- **Severity vocabulary: MAJOR / MINOR / NOTE.** If an external tool or
  report uses HIGH/MED/LOW, map onto this vocabulary explicitly (e.g. a
  medium RUSTSEC on the updater path was treated as MINOR with the
  mitigation recorded in the audit doc). NOTEs are accepted-and-recorded,
  not chased.

## 7. Hunt protocol

1. **Scope** — name the subsystems and the baseline commit; a focused round
   (see [`AUDIT-2026-09-14-ROUND2.md`](AUDIT-2026-09-14-ROUND2.md)) may
   scope to a few subsystems instead of the full tree.
2. **Triage** — lead assigns MAJOR/MINOR/NOTE and routes; hunters' reports
   use the Trigger / Before / After-evidence table shape from ROUND2 — that
   table **is** the report format.
3. **Fix rounds** — per §6: one commit per round, pinning tests named,
   changelog Fixed section updated (`docs:` commits alongside, e.g.
   `abb80b9`).
4. **Convergence** — a fresh round over the last fix commit finds nothing
   new → record residuals and close. The changelog gets the round summary;
   the audit doc (for full audits) records the loop's termination point.

Worked examples: [`AUDIT-2026-09-17.md`](AUDIT-2026-09-17.md) (full-tree,
four parallel reviewers, four verification rounds) and
[`AUDIT-2026-09-14-ROUND2.md`](AUDIT-2026-09-14-ROUND2.md) (focused,
table-shaped findings).

## 8. Debug loop

1. **Log file first.** The native log is
   `%APPDATA%/dev.leftleg.app/logs/leftleg.log` (AGENTS.md rule 5) — the
   global trap appends there with a visible banner in the UI. Local
   untracked working artifacts `leftleg-run.log` / `leftleg-stderr.log`
   (and `tauri-dev*.log`, `cargo-build.log`) in the repo root are your own
   redirect targets from dev runs — read those before re-running anything
   (§10: they are gitignored, never committed, never cleaned).
2. **Devtools** are enabled in release builds too — right-click → Inspect
   in the webview.
3. **Reproduce in a test before fixing** (§4.7) — a manual repro that dies
   with the session is worth nothing; the pinned test is the deliverable.
4. `npm run tauri dev` for hot reload; vite serves on `localhost:1420`
   (strict port — a stale dev server blocks the next one).

## 9. Release

**Link-only:** follow [`docs/RELEASE.md`](RELEASE.md) — tag `vX.Y.Z` → CI
validates version identity → signed NSIS + `latest.json` → **draft**
release → publish the draft. Two gotchas worth repeating here:

- The updater signing prompt hangs non-interactive shells: the build
  finishes bundling, then blocks forever on the `Password:` prompt
  (press **Enter** — the key is unencrypted). Tell-tale: a finished
  `Leftleg_<V>_x64-setup.exe` with **no `.sig`** beside it — that build
  cannot serve updates.
- Use `npm.cmd` (not `npm`) on PowerShell 5.1 — the `.ps1`
  execution-policy block.

The version bump is its own chore: one commit touching the four manifests —
`src-tauri/tauri.conf.json` (canonical build identity), `package.json`,
`package-lock.json` (both `version` fields), `src-tauri/Cargo.toml` (run
`cargo check` to sync `Cargo.lock`) — plus the `CHANGELOG.md` entry, per the
`MAJOR.FEATURE.FIX` policy in AGENTS.md. Bump at release prep, not per
working batch; the patch digit stacks across feature bumps.

## 10. Windows / environment gotchas

The trip-hazard list. Most of these have bitten at least once.

- **CRLF noise.** `core.autocrlf=true` is set; there is deliberately
  **no `.gitattributes`** — never add one, never normalize the whole tree.
  Check whitespace-only diffs with `git diff --check` before committing.
- **One gate run at a time in a shared tree.** Parallel agents' `vite build`
  / `cargo` runs collide in `dist/` and `src-tauri/target/`. Serialize gates
  across agents; run heavy checks from your own worktree if you must
  parallelize (§3).
- **Integration tests need real pi.** `companion.integration.test.ts`
  spawns `pi --mode rpc` from PATH; CI pins 0.85.1 globally. Without it the
  suite times out — this is an environment gap, not a code bug.
- **stores.ts is ~1830 lines on purpose.** The split threshold is ~3000
  lines; stores.ts headroom is deliberate. Don't reorganize
  opportunistically — flag the idea instead (per the repo's scope
  discipline).
- **The gate is one command.** Even comment-only changes get the full
  `npm run build`; a lone warning fails the gate. No partial gating.
- **Silent capability failures.** A new `invoke` returning `undefined` with
  no error usually means a missing permission in
  `src-tauri/capabilities/default.json` (AGENTS.md rule 3). Check that
  file first.
- **Test mocks must grow with `api.ts`.** Every new `api.ts` export needs an
  entry in the module mocks (`stores.test.ts:5-18`,
  `SettingsWorkspace.test.ts`, `esc-ladder.test.ts`, …) or those suites
  fail wholesale. New browser globals (e.g. `matchMedia`) need jsdom
  shims — see `rpc-acceptance.test.ts:133-138` for the pattern.
- **Local untracked artifacts are working leftovers.** `cargo-build.log`,
  `leftleg-run.log`, `leftleg-stderr.log`, `npm-install.log`, `tauri-*.log`,
  `.serena/`, `.pi/` are gitignored dev residue — don't commit them, don't
  clean them either.
- **Plans go to `.agents/plans/`** as one phased markdown doc per effort.
- **Rust is at `~/.cargo/bin`** — add to PATH in fresh shells (AGENTS.md).
  Node 22+ per `.nvmrc` / `package.json` engines.
