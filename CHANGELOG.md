# Changelog

All notable changes to Leftleg are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); versioning
follows the `MAJOR.FEATURE.FIX` policy in `AGENTS.md` and the version in
`src-tauri/tauri.conf.json`.

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
