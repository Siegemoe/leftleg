# Changelog

All notable changes to Leftleg are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); versioning
follows the `MAJOR.FEATURE.FIX` policy in `AGENTS.md` and the version in
`src-tauri/tauri.conf.json`.

## [Unreleased]

### Added

- Nightly release channel: a scheduled 03:23 UTC build from master publishes
  a `vX.Y.Z-nightly.N` prerelease and rolls its updater feed onto a
  `nightly` release (`latest-nightly.json`); the stable feed is untouched —
  `/releases/latest` never resolves to a prerelease. A nightly _install_ is
  a build flavor (its updater endpoint is baked in), not a runtime toggle.
  Nightly channel mechanics live in `docs/RELEASE.md`.
- Subagents right-panel view: every subagent run in the current session —
  live runs on top with a pulsing dot and per-agent status from the
  extension's heartbeat snapshots, finished runs newest-first with
  per-agent model, token/cost usage, and errors. Derived entirely from the
  transcript items (no second store), so it survives session switches.
  Cross-session history (`.pi/subagent-history.json`) needs a
  path-validated Rust command and stays a follow-up.

### Changed

- Composer controls regrouped: the branch chip, model selector, and
  thinking level moved directly under the chat bar (the keybinding hint
  pushed to the row's right end); the status bar footer now carries run
  telemetry only; the updater chip and version live in the sidebar footer.

## [0.7.2] — 2026-09-19

### Added

- Title-bar logo returns to the start view: the active project's pi process
  keeps running in the background (mid-stream turns continue feeding the
  sidebar), and switching back restores the transcript, queue, and extension
  state. The right panel collapses at the start view by default — not
  locked: a dock button reopens it, and entering a project restores it.
- Start-view composer: attachment picker with removable chips and image
  thumbnails, clipboard image paste (20 MiB cap), and a send arrow running
  the folder-picker flow (images in the images param, text files inlined as
  fenced blocks). A rejected first prompt recovers its attachments into the
  destination composer draft alongside the text.
- Per-project settings card: each row in the sidebar's project-selector
  dropdown gains a hover-revealed gear, and right-clicking a project row
  opens a settings card scoped to that project (rename, icon, color,
  hide/restore, open folder) without switching to it; "Advanced settings…"
  hops into the full modal.
- Dedicated Key bindings section in Settings: every app shortcut lives in a
  registry; click Change and press a combination (Ctrl/Cmd + key) to
  rebind; a duplicate chord is named after the action that already owns it
  and is never applied; overrides persist in GUI state; Reset all restores
  the defaults. The File/View menu hint-keys render the effective bindings.
- Per-session activity indicator: the status bar's global idle/working pill
  is replaced by a per-session "working" chip (pulsing accent dot) in each
  session row, right of the session's timestamp — session-specific cues for
  multiple simultaneously running sessions across projects.

### Fixed

- Overlay ladders close topmost-only: Escape now steps aside for higher
  layers everywhere — the settings modal, both cards, the file viewer, the
  About card, and every menu/popover (the app closes exactly one layer per
  press, verified against every co-openable pair) — the Settings modal
  honors Escape and confirms before discarding unsaved edits, and keyboard
  accelerators stand down while a modal owns the screen.
- At the start view, project-scoped actions can no longer reach the project
  running in the background: new chat, runtime settings, compaction, abort,
  clone, and export stand down with a visible note (runtime controls are
  disabled with an explanation), and the Status dock shows its empty state
  instead of the backgrounded project's task list while pi identity and
  extension checks keep resolving.
- A session's "working" chip settles when its pi process exits (clean stop
  → idle, crash → attention) and a restart starts it clean; previously the
  chip kept pulsing on a dead process until the next full turn.
- Key-binding capture no longer disarms itself the moment it starts, and
  exotic keys (Dead/Process, Ctrl+plus) are canonicalized before saving.
- Start-view composer: staged attachments survive returning to the start
  view and count in the update-check audit; nothing can be typed, pasted,
  or removed while a project is opening (a chip removed mid-flight no
  longer still delivers or resurrects); the paperclip stands down during
  an update install.
- Per-project settings: "Advanced settings…" edits the chosen project's own
  configuration through that project's pi process — even from the start
  view or with a different project in the foreground — instead of silently
  editing whichever project was active.
- Scope filter resets when its project is hidden; menu hint keys reflect
  effective bindings; a stale-view request can no longer land in the global
  error banner.

## [0.6.2] — 2026-09-18

### Added

- Diff and Files docks with guarded native Git summaries, a tracked-source
  browser, lazy file statistics, and a movable code-viewer card.
- Branch-hover diff totals and a subagents dock for current agent activity.
- T3-style prompt rail riding the sidebar's edge (travels to the window edge
  when the sidebar hides): one tick per user prompt in the session in view —
  click jumps the chat to that prompt, and the active tick follows the scroll
  position. The chat column is capped at 50% of the window (transcript and
  composer share it), and the status bar's left edge follows the sidebar's
  edge (full width only when the sidebar is hidden).
- New-project card — folder name plus a native parent picker — reachable
  from the sidebar scope picker, the settings project manager, and
  File → New Project… (Ctrl+Shift+N), backed by a validated
  create-folder command that rejects reserved Windows device names.
- File/View menu refresh: New Project…, Diff…, and Files… entries; the
  sidebar scope picker gains a New project… row and no longer spills past
  the window edge at its narrowest.

### Fixed

- Prevent delayed RPC prompt delivery after a stdin write timeout by poisoning
  and stopping the ambiguous transport before queued writers can proceed.
- Bound the complete pi-update process tree and inherited output pipes with a
  Windows Job Object, including the case where the direct child exits first.
- Serialize startup Pi updates with prompts, navigation, settings writes, and
  app installation for the full npm update window.
- Preserve session-name synchronization through rename debounce and reject
  incomplete numeric input without clearing stored settings.
- Keep NUL-delimited Git paths verbatim, contain all new repository commands,
  and prevent stale file-stat requests from populating a refreshed tree.

## [0.5.1] — 2026-09-17

### Added

- System tray with close-to-tray: the X button (and Alt+F4) now parks the app
  to the tray instead of exiting, so background pi projects keep streaming;
  File → Exit and the tray's Quit are the real exits and still kill pi
  cleanly. Left-click toggles the window — hides one in active use, raises
  one parked a while (a Windows tray-click defocus quirk is explicitly
  handled) — and double-clicks are debounced. A single-instance guard turns
  Start-menu relaunches of the hidden app into focus-the-existing-window.
- pi processes are killed in parallel on quit (scoped threads): closing out
  many background projects takes about one taskkill span instead of N
  serialized ones.

### Changed

- New app icon set: bold monochrome mirrored-LL (thin L left, extra-bold
  mirrored L right, dark tile, legible at 16 px); unused android/ios icon
  variants dropped (Windows-only bundle).
- Docs currency pass across README, CONTRIBUTING (Node 22, CI-driven release
  flow, commit conventions), ROADMAP (0.3–0.4 record + next-sweep framing),
  SECURITY (audit pointer, supported versions, media companion scope), and
  GAP-ANALYSIS (session-refresh mechanism wording).

## [0.4.1] — 2026-09-17

### Fixed

- Startup pi updater now fires after boot settles: the launch-time call raced
  boot's navigation every start (fast-pathed the wait, then skipped at the
  re-check with no debounce stamp), so automatic pi harness/extension updates
  never ran. Regression-tested on the real timeline.
- rustls 0.23.44 → 0.23.45 (RUSTSEC-2026-0285, TLS 1.3 handshake boundary
  flaw, medium 5.3) — rustls backs the app-updater's TLS path; downloads are
  minisign-verified, so exposure was theoretical.

### Changed

- First CI run on the repo: quality gate green; security job now actively
  enforcing (`.cargo/audit.toml` records the accepted glib advisory in-tool;
  unmaintained-crate warnings are reported but don't fail).
- Versioning policy codified (`MAJOR.FEATURE.FIX`), CLAUDE.md agent entry
  point added, changelog backfilled 0.2.1–0.4.0.

## [0.4.0] — 2026-09-17

### Added

- Native path boundaries: scoped `open_path` (tool cards, artifacts, and the
  logs folder route through containment + an executable-extension denylist),
  `pick_and_read_files` dialog+read attachments (the renderer can only read
  what the user just picked), and pi-update single-flight with a panic-safe
  guard.
- Brand assets, per-project icon rendering, right-panel dock placeholders,
  thinking-card ANSI cleanup.
- CI: quality gate (svelte-check, vitest, vite, cargo) on every push/PR and a
  weekly security audit job (npm audit + cargo audit).

### Fixed

- Three-round fresh-eyes review loop (see `docs/AUDIT-2026-09-17.md`): null
  CSP; non-async Tauri commands blocking the main thread; pi-update subprocess
  bounded and killable; log rotation + line caps; streaming race (steer
  accepted before `agent_start`); management-channel identity (companion
  provenance anchored to the agent dir); webview navigation hijack (http(s)
  anchors to the OS browser, non-http navigation blocked); un-timed status
  notes; id-keyed chat items (duplicate-key crash); composer draft pruning;
  settings textarea Enter handling; opener capability narrowed; 50 MiB
  attachment batch budget; symlink-safe path containment; startup pi updater
  navigation race (fires post-boot, bounded wait, no-stamp retry).

### Changed

- `opener:default` capability replaced with explicit `allow-open-url` /
  `allow-default-urls` (unscoped reveal grant dropped).

## [0.3.0] — 2026-09-15

### Added

- Startup pi harness/extension update pipeline: guarded Rust runner,
  integrity gate, 12-hour debounce; extensions section in the status card.
- Project icons: 40-emoji picker with user-chosen colors across the sidebar
  and start screen.
- Response polish: per-response day/time headers, tool/thinking/turn timers,
  copy-response button.
- Right panel: Status/Artifacts cards beside the chat, resizable + persisted
  (the dropdown status card's redundant Updates section removed).

### Fixed

- Project state and media handling hardening; thinking-card cleanup
  (`thinking_end` adopts authoritative content, render-time sanitize pass).

## [0.2.3] — 2026-09-14

### Changed

- Footer layout: theme + settings on row 1, connection + branch chip on row 2.

## [0.2.2] — 2026-09-14

### Added

- Custom title bar with menus, proactive update control, model dropdown.

### Changed

- Composer reset, sidebar restructure, startup scene, git chip, status card;
  model pinning/search, status pill cleanup, filter-row swap; sidebar footer
  cleanup, media settings under Models.

## [0.2.1] — 2026-09-14

### Added

- Image generation: `image_generate` companion (OpenRouter Image API,
  pi-registry auth), image placeholder UX, artifacts browser, asset-protocol
  streaming with project-scoped grants.

## [0.2.0] — 2026-09-14

### Added

- Settings workspace: management bridge to pi (`/settings-mgmt` companion) with
  revision-checked, atomic, read-back-verified writes; core config, extension
  config editors, and per-package forms (plan, subagent, permissions, lens,
  distill, tool-display, Serena YAML).
- Updater visibility: durable check-state store, status-bar update chip,
  Settings → Updates row with manual "Check now", human-readable failure
  reasons (e.g. missing feed).
- Build identity single-sourced from `src-tauri/tauri.conf.json` (what the
  updater compares is what the UI displays).
- Signed release artifacts + hand-authored `latest.json` feed
  (`docs/RELEASE.md`).
- Research: image generation via OpenRouter for Leftleg.

### Fixed

- ~19 correctness fixes across a two-round audit, including: stale transcript
  when opening another session of a streaming background project; unpaired
  history tool calls rendering as eternal spinners after reload; running tool
  cards left spinning after pi dies; prompt-assembly fence escaping for
  attachments containing backtick fences; extension-dialog double-submit and
  unhandled send failures; settings save failures surfacing as unhandled
  rejections instead of visible notes; stale settings revision after failed
  read-back; prototype-pollution guard for config paths; orphaned pi child
  process on partial stdio setup; unbounded JSONL line buffering in the RPC
  bridge reader.

### Changed

- Settings status/cache hardening: serialized immutable snapshots,
  hash-based content revisions, same-directory atomic writes.

## [0.1.0] — 2026-09-12

### Added

- Initial release: multi-project pi orchestration, streaming transcripts with
  tool cards, steering/follow-up queue, extension dialogs, session history and
  sidebar, GUI state persistence, vitest + cargo test suites gated into the
  build.
