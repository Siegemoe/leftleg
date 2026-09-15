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

## v0.1 — polish (next)
- [ ] Acceptance test: use Leftleg to develop Leftleg, end to end
- [ ] pi-exit → in-app restart button (currently: status note only)
- [ ] Code-block syntax highlighting in markdown
- [ ] Session list: live refresh on new sessions (fs watch or poll)
- [ ] Queue surface: show pending steer/followUp texts (pi sends them in queue_update)
- [ ] pi-checkpoint integration: big obvious "Undo Agent Changes" button → `/undo`
- [ ] pi-background-tasks surface: attach/kill from status bar
- [ ] Model picker: group headers sticky, show cost column, remember favorite

## v0.2 — deeper integration
- [ ] `get_entries` cursor-based incremental sync (replaces full get_messages reloads)
- [ ] Fork/clone UI on message items (RPC fork/clone/get_fork_messages)
- [ ] pi-plan mode UI (plan → implement → verify → review states)
- [ ] pi-todo task graph panel
- [ ] Subagent thread inspector
- [ ] Diff viewer modal (monaco or codemirror) instead of pre blocks
- [ ] Multi-project: session list grouped by cwd, quick switch (pi restart per project)

## v0.3 — ambition
- [x] Auto-update (tauri updater) — shipped in 0.2.2: update banner + Settings → Updates; feed = `releases/latest/download/latest.json`
- [ ] Tray icon + background sessions — close-to-tray (window close currently kills the app; muscle-memory trap)
- [ ] Telemetry-free crash reporting via the log pipeline
- [ ] Automated UI smoke tests (click-through: launch → pick project → send → tool card renders)
- [x] Rust unit tests: JSONL line classification, pending map, session header parse (+ first-user-message extraction, base64)

## Non-goals (v0 philosophy)
No agent-state database. No custom compaction/context engine. No multi-agent scheduler. Pi owns the brain; Leftleg owns the desk.
