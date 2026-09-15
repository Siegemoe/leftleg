# Leftleg — Right Panel + UI Polish + Startup Updater (phased)

Decisions locked with Zack: chat narrows with composer inline (sidebar-style drag handle); terminal card deferred to phase 2; startup security check = extension **integrity only** (no dependency scanning); pi update runs via `pi update --all`.

Recon sources: 4 scout reports (layout, thinking-card, startup/icons, pi capabilities) + `pi --help` / `docs/rpc.md` verification.

---

## Phase 1 — Right panel hosting Status + Artifacts (replaces both current actions)

**Stores** (`src/lib/stores.ts`, idiom at :15–20 and bootImpl :1327–1396):
- New writables: `rightPanelOpen` (bool, default false), `rightPanelTab` (`"status" | "artifacts"`), `rightPanelWidth` (number, default 420).
- Hydrate + subscribe-to-persist all three in `bootImpl` — zero Rust changes (`leftleg.json` is schemaless).

**New component** `src/components/RightPanel.svelte`:
- `<aside style="width:{$rightPanelWidth}px">` sibling of `<main>` inside `.shell` (App.svelte ~:50), after main; `flex-shrink:0; border-left:1px solid var(--border)`.
- Resize handle lifted from Sidebar.svelte:165–181 mirrored: `left:-3px`, `startWidth - dx`, same clamp family (min ~320, max `innerWidth - 640`).
- Tab strip at top (Status | Artifacts) + close button (`rightPanelOpen.set(false)`).
- Body: `{#if $rightPanelTab === "status"}<StatusCard/>{:else}<ArtifactsCard/>{/if}`.

**Extract StatusCard** — new `src/components/StatusCard.svelte`:
- Move `openStatus()` data-loading (TitleBar.svelte :40–90: todo scan via `get_messages`, `piModuleInfo()`, staleness guards) + the three `<section>`s (:229–264) out of TitleBar into the card component.
- **Drop the Updates section entirely** (TitleBar.svelte :244–256) — redundant with startup updater (Phase 3). Todos + Pi module sections remain.

**Convert Artifacts** — `src/components/Artifacts.svelte`:
- Strip the fixed overlay wrapper (`.overlay` + dim) and dialog chrome; keep header (title/project/refresh) + tabs as card content. Keep its `$effect` reload keyed on tab visibility + `$projectDir`.

**Re-wire triggers** (this REPLACES the current actions):
- TitleBar "Status" button (:224) and "Artifacts" button (:216), plus the View-menu items: now do `rightPanelTab.set("status"|"artifacts"); rightPanelOpen.set(true)` (toggle-off if same tab already open).
- Delete: TitleBar `.statuswrap` dropdown markup/styles + outside-pointerdown/Escape handlers; App.svelte :101–103 `{#if $artifactsOpen}<Artifacts/>{/if}` overlay gate; `artifactsOpen` store (check StatusBar/usages; replace).
- Keep app-self-update surfaces untouched: App banner, StatusBar update chip, Settings row (`updater.ts` unchanged).

**Chat narrows, composer inline**: automatic from flex layout — `.chatwrap`/`main` keep `min-width:0`; composer stays docked (Chat.svelte :53–63). No composer changes in this phase.

---

## Phase 2 — Thinking card cleanup (friendly to read)

- `stores.ts` `message_update` handler: `thinking_end` adopts authoritative content — `b.text = d.content ?? b.text` (mirror `text_end` :500–503). Fixes streaming garbage surviving until `message_end`.
- New `sanitizeThinking(text)` in `src/lib/thinking.ts` (or `sidebar-model.ts` sibling): strip stray `</think>`/`edevent`-style tag debris, collapse 3+ blank lines to one, trim leading/trailing whitespace, drop common provider red-herring artifacts.
- `MessageView.svelte` :64–71: render sanitized text; keep `<details>` collapse + pre-wrap; consider subtle paragraph spacing (collapse runs already handled). Unit tests for sanitize in `src/lib/*.test.ts` (vitest, part of `npm run build`).

---

## Phase 3 — Startup harness/extension updater + integrity check

**Rust** — one new guarded command (pattern: `run_git` sessions.rs:400 / `write_agent_extension` lib.rs:270):
- `run_pi_manager(args: Vec<String>) -> { exitCode, stdout }`: resolves pi via the existing `where.exe pi.cmd` shim logic (pi.rs:87–110), spawns `pi update --all` (or given subcommand) with piped stdio, fixed timeout, no shell, `CREATE_NO_WINDOW`; never passes user strings beyond whitelisted args.
- `pi_integrity_report() -> { extensions: [{source, path, trusted, modified?}] }`: enumerates `pi list` output + reads installed dirs (`~/.pi/agent/npm/node_modules/*`, git clones) — classifies each source as npm-registry (`npm:` spec), git (pinned ref), or **local-file/unregistered (flagged)**. Read-only; no network.

**Frontend** — new `src/lib/piUpdate.ts`:
- `runStartupPiUpdate()`: fire-and-forget after `bootImpl`'s `refreshSessions()` (stores.ts ~:1396) and NOT per app launch on every pid — debounce: at most once per 12h via timestamp in gui state; skip while `updateInstallLock` or a pi process is streaming in any project.
- Sequence: integrity report → if unregistered/modified extensions found: banner-grade notification, skip auto-update for safety → else run `pi update --all`, parse text output + exit code, surface a dismissible notification (installed version deltas); log everything to `append_log`.
- `pi update` text output is human-readable (no JSON) — parse minimal version deltas, treat non-zero exit as failure with logged output. Never block boot or prompt; risk accepted by user.
- Notification UI: reuse the notification pipeline (`notifications` store, stores.ts ~:160) — no new surface.
- Integrity summary also shown in the right-panel Status card (new small section under Pi module: "Extensions — N trusted, 0 flagged") when a fresh report exists.

---

## Phase 4 — Message polish (timers, copy, day/time headers)

All timing is GUI-measured (pi RPC has NO duration fields; every message has `timestamp`, `turn_start.timestamp` exists, `tool_execution_start/_end` correlate by `toolCallId` — verified in dist type decls).

**Timers** (`src/lib/stores.ts` + `MessageView.svelte`):
- Track in message/turn state: tool exec duration (`tool_execution_start` → `_end` per `toolCallId`), thinking duration (`thinking_start` → `thinking_end`), turn duration (`turn_start.timestamp` → end-of-turn message timestamp). Store ms on the block/message objects; format (`2.4s` / `1m 12s`) at render.
- Render spots: tool card header (per-command), thinking summary ("Thought process · 4.1s"), turn-end meta line (total turn).

**Copy response button**: clipboard button on assistant messages (MessageView) — copies the concatenated text blocks. Check existing clipboard usage patterns first (none found in recon).

**Day/time headers**: group consecutive assistant/user messages by calendar day in the chat scroller — "Today 3:42 PM" / "Yesterday" / "Tue, Sep 9" (locale `Intl` short date + standard time), inserted as divider rows in `Chat.svelte` rendering from message `timestamp`.

---

## Phase 5 — Project icons: bold colors + bigger set

- `ProjectMeta` +`color?: string` (stores.ts :180–187) — persisted in `leftleg.json`, no Rust change.
- SettingsWorkspace picker (:826–830): expand from 10 to ~40 emoji (categories: files/orbs/animals/nature/symbols/transport); add a bold **color swatch row** (~12 saturated hues + none).
- Application: StartScreen :86, Sidebar group header :378, scope picker :283/:320 — icon colored via `style="color: {color}"` with emoji-safe rendering (color mostly benefits monochrome glyphs + the chip background tint: subtle `color-mix` background on `.scope-icon`/`.icon`).

---

## Phase 6 — Terminal card (deferred, per your call)

Real PTY via `portable-pty` in Rust bridged to xterm.js in the right panel, third tab. Separate design pass after Phase 1 lands.

---

## Verification per phase
`npm run build` (svelte-check 0/0 + vitest + vite build) after every frontend touch; `npm run check:rust` + `npm run test:rust` for the Phase 3 Rust command (add a unit test for arg whitelisting/exit parsing). Manual smoke: right panel open/resize/persist across relaunch; thinking card before/after on a streaming session; startup update run with a stale extension; timer correctness against a known tool call.

## Order
Phase 2 → 1 → 4 → 5 → 3 → 6 actually minimizes risk: thinking cleanup and icons are small wins first, right panel is the structural change, startup updater last (riskiest, user-accepted). Terminal (6) after 1 proves the panel.
