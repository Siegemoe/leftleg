# Changelog

All notable changes to Leftleg are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); versioning
follows the version in `src-tauri/tauri.conf.json`.

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
