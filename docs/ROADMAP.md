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

## v0.5.1 — shipped

- [x] System tray + close-to-tray with single-instance guard: X/Alt+F4 parks the app so background projects keep streaming; File → Exit and the tray Quit are the real exits; Start-menu relaunch focuses the hidden window
- [x] Parallel pi kill on quit (scoped threads) — many background projects close in one taskkill span instead of N serialized ones

## v0.6.2 — shipped (tagged and published 2026-09-18)

- [x] Prompt rail replaces the session rail: one tick per user prompt in view, click jumps the chat, the active tick follows scroll (`activePromptId`); it travels to the window edge when the sidebar hides, and the "+" new-chat button shows only while it's collapsed
- [x] Chat column owns the width: 50% of the window (min(100%, 50vw)), centered, held steady as side panels open/close — the Composer no longer self-caps
- [x] Status bar rides the sidebar's right edge; full window width only when the sidebar is hidden
- [x] New-project card (modal above Settings) from the scope picker, the settings project manager, and File → New Project… (Ctrl+Shift+N), backed by the validated native create-folder command (reserved Windows device names rejected; an existing dir opens idempotently)
- [x] Monochrome accent — `--accent` near-black/near-white per theme, color reserved for indicators and per-project identity
- [x] Inline copy feedback (green check + "Copied", 2s) on assistant responses and artifact paths; turn duration beside the copy button
- [x] Diff and Files docks (working-tree diff summary, repo file tree, branch-hover totals) + movable code-viewer card; Subagents/Browser/Terminal docks remain placeholders
- [x] File/View menu refresh: New Project…, Diff…, Files…; scope picker left-anchored with viewport clamps and a New project… row

## Unreleased — working batch (2026-09-18)

- [x] Title-bar logo returns to the start view: the active project keeps running in the background (mid-stream turns continue); switching back restores the view
- [x] Right panel collapses at the start view — a default, not a lock: dock buttons reopen it, entering a project restores it
- [x] Start-view composer gains attachments (removable chips, image thumbnails, clipboard paste ≤ 20 MiB) and a send arrow running the folder-picker flow
- [x] Per-project settings card from the project selector dropdown: gear button / right-click opens a card scoped to that project (rename, icon, color, hide/restore, open folder) without switching to it
- [x] Dedicated Key bindings section in Settings: registry-driven shortcuts, click-to-rebind capture, duplicate chords named and refused, overrides in GUI state, Reset all; menu hint-keys reflect effective bindings
- [x] Per-session activity cue: the status bar's global idle/working pill moved into each session row as a pulsing "working" chip, in preparation for multiple concurrent sessions across projects

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
- [ ] Subagent thread inspector (the Subagents dock tab exists in the right panel; its view is still a placeholder)
- [ ] Diff viewer modal (monaco or codemirror) instead of pre blocks (the Diff dock and code-viewer card don't cover ToolCard's pre-block edit diffs)
- [ ] Telemetry-free crash reporting via the log pipeline
- [ ] Automated UI smoke tests (click-through: launch → pick project → send → tool card renders)

## Non-goals (v0 philosophy)

No agent-state database. No custom compaction/context engine. No multi-agent scheduler. Pi owns the brain; Leftleg owns the desk.
