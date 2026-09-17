# Leftleg Roadmap

## v0 — shipped (this state)
- [x] Tauri 2 + Svelte 5 shell, light/dark/system theme
- [x] pi RPC bridge: spawn per project dir, JSONL framing, id correlation, event forwarding
- [x] Streaming chat: text/thinking deltas, collapsible thinking, abort, steer-while-streaming
- [x] Tool cards: status, args, streaming output, edit diffs (+N −M), open file
- [x] Sessions: list (JSONL header parse), open/switch, new session, rename
- [x] Settings card: model picker (searchable), thinking level, steering/follow-up modes, auto-compaction, compact now, session name, project dir
- [x] Composer: images (RPC `images` param) + text files (inlined fenced blocks)
- [x] Extension UI dialogs (select/confirm/input/editor)
- [x] Error instrumentation: global trap → visible banner + logs/leftleg.log; devtools in release
- [x] Capabilities: core + dialog + opener
- [x] NSIS installer, Start Menu launch

## v0.2.x — shipped (beyond the v0 list)
- [x] Custom title bar with File/Edit/View/Help menus, proactive update control, model dropdown
- [x] Model picker: pinning + search
- [x] Media: image_generate companion, artifacts browser, media defaults in Settings → Models
- [x] Startup project scene; per-project session groups, Pinned/Active/Settled sections, drag-to-pin
- [x] Sidebar footer: theme + settings (row 1), connection + git branch chip (row 2)
- [x] CI release pipeline proven on v0.2.3 (tag → signed NSIS + latest.json → draft → publish; see docs/RELEASE.md)

## v0.3–v0.4 — shipped
- [x] Auto-update (tauri updater) — shipped in 0.2.2: update banner + Settings → Updates; feed = `releases/latest/download/latest.json`
- [x] CI: quality gate on every push/PR + weekly security audit job; first run 2026-09-17 (0.4.0)
- [x] Native path boundaries: scoped `open_path`, `pick_and_read_files` attachments, pi-update single-flight (0.4.0)
- [x] Management-channel identity gate, streaming-race fix, webview navigation/XSS caps (0.4.0)
- [x] Tag-driven signed releases (release.yml validates tag == manifest versions → signed NSIS + `latest.json` → draft)
- [x] pi-exit → in-app Restart & resume (was status-note only)
- [x] Queue surface: pending steer/followUp texts shown in Composer + StatusBar
- [x] Session list: refreshes on agent settle + session actions (fs-watch for external sessions still open)
- [x] Rust unit tests: JSONL line classification, pending map, session header parse (+ first-user-message extraction, base64)
- [x] System tray + close-to-tray with single-instance guard (unreleased; next feature bump 0.5.1)

## Next sweep — the foundation (MAJOR → 1.0.0 per the versioning policy)
Multi-harness support (codex / Claude Code / DSH / cursor) behind an adapter
boundary, routing (local models + OpenRouter + 2–3 more providers), and
Windows+Linux. Ranked breakdown and remaining pi-RPC gaps:
[`GAP-ANALYSIS.md`](GAP-ANALYSIS.md).

## Parked / smaller polish
- [ ] Acceptance test: use Leftleg to develop Leftleg, end to end
- [ ] Code-block syntax highlighting in markdown
- [ ] pi-checkpoint integration: big obvious "Undo Agent Changes" button → `/undo`
- [ ] pi-background-tasks surface: attach/kill from status bar
- [ ] Model picker: group headers sticky, show cost column, remember favorite
- [ ] `get_entries` cursor-based incremental sync (replaces full get_messages reloads)
- [ ] Fork/clone UI on message items (RPC fork/clone/get_fork_messages)
- [ ] pi-plan mode UI (plan → implement → verify → review states)
- [ ] pi-todo task graph panel
- [ ] Subagent thread inspector
- [ ] Diff viewer modal (monaco or codemirror) instead of pre blocks
- [ ] Telemetry-free crash reporting via the log pipeline
- [ ] Automated UI smoke tests (click-through: launch → pick project → send → tool card renders)

## Non-goals (v0 philosophy)
No agent-state database. No custom compaction/context engine. No multi-agent scheduler. Pi owns the brain; Leftleg owns the desk.
