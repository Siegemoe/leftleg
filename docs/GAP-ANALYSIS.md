# pi surface gap analysis — 2026-09-17

What Leftleg wires up today vs. what pi's RPC surface offers, and what the
next feature sweep (multi-harness, multi-routing, Windows+Linux) needs.
Derived from code (stores.ts event handlers + request sites, mgmt.ts,
types.ts) and pi 0.85.1's RPC surface.

## RPC methods — in use

`prompt` (with streamingBehavior for steer/follow-up), `abort`, `abort_retry`,
`get_state`, `get_messages`, `get_commands`, `get_available_models`,
`get_session_stats`, `new_session`, `switch_session`, `clone`, `compact`,
`export_html`, `set_model`, `set_session_name`, `set_steering_mode`,
`set_follow_up_mode`, `set_thinking_level`, `set_auto_compaction`,
`set_auto_retry`, `clear_queue`, `extension_ui_request`,
`extension_ui_response`.

## RPC methods — unused, and what they unlock

| Method | Unlock |
| --- | --- |
| `steer` | Dedicated steering call; today steering piggybacks on `prompt` + streamingBehavior. Equivalent outcome, but the dedicated method is the documented path once multi-harness arrives (each harness may not have the piggyback). |
| `follow_up` | Same story for follow-up mode. |
| `cycle_model` / `cycle_thinking_level` | One-key model/thinking cycling — cheap keyboard shortcuts (title bar or Ctrl+M/Ctrl+T style). |
| `get_available_thinking_levels` | Render the real per-model thinking levels instead of the fixed list; feeds the settings card and cycle_thinking_level. |
| `bash` / `abort_bash` | pi-managed background bash sessions with GUI cards — long-running commands with live output the agent can poll. Distinct from tool-call cards. |
| `fork` / `get_fork_messages` | Session branching UI: try an alternative path from any point, keep both branches. Biggest missing session-management feature. |
| `get_entries` / `get_tree` | Entry-tree replay: exact full-history rebuild (GUI today rebuilds from `get_messages` and can lose compacted/entry detail), plus a branch tree view for forked sessions. |
| `get_last_assistant_text` | Cheap retry/quote affordances (quote-last-answer into the composer). |

## Events — handled

agent_start, agent_end, agent_settled, message_start, message_update,
message_end, turn_start, tool_execution_start/update/end,
compaction_start, compaction_end, queue_update, extension_ui_request,
extension_error, notify, set_editor_text, auto_retry_start, auto_retry_end.

## Events — unhandled (consequences)

| Event | Consequence of not handling |
| --- | --- |
| `turn_end` | Turn lifecycle is inferred from message_end/agent_end with a turnStartTs fallback. A turn that ends without either emits (or a harness that only sends turn_end) would leave turn timing/streaming indicators wrong. Wire it as a first-class turn close: clear streaming, close the turn meta line, fire the artifacts refresh. |
| `bash_execution_update` | pi's native bash tool streams updates on its own event; GUI only renders tool_execution_* cards, so native-bash progress shows at completion granularity (and the BashItem type is barely used). |
| `summarization_retry_start` / `..._retry_end` | Auto-compaction retry is invisible: the status note shows compaction_start/end, but a retry pass reads as a stall. Cheap: status-note text + session status pill. |

## Ranked gaps for the next sweep

1. **Harness abstraction layer** — `types.ts`/`stores.ts` speak pi's event
   vocabulary 1:1. Codex / Claude Code / DSH / cursor support needs an
   adapter boundary (normalized ChatEvent → GUI items) with pi as the first
   implementation, before any second harness lands. This is the structural
   change the sweep is for; every other gap is layered on it.
2. **Session branching (`fork` + `get_fork_messages` + `get_tree`/`get_entries`)**
   — the largest missing pi capability in the GUI; also needs the entry-tree
   rebuild for faithful history.
3. **`turn_end` + `bash_execution_update` + `summarization_retry_*`** —
   small, but they complete the streaming/turn lifecycle contract and matter
   more, not less, when a second harness has different event sets.
4. **Routing surface** — model picker is provider-aware already; local-model
   routing (and 1–3 more providers) needs pi-side provider config surfaced in
   Settings → Models (endpoints, keys management, per-project defaults exist).
5. **Background bash (`bash`/`abort_bash`)** — new tool-card kind + abort
   affordance; feeds the Terminal dock placeholder in the right panel.
6. **Thinking-level model awareness (`get_available_thinking_levels`)** —
   replaces the fixed list; keyboard cycling via `cycle_*`.
7. **Live session refresh** — sidebar re-lists on a 30s poll and event
   nudges; an fs-watch (or pi notification) removes the staleness window.
8. **`steer`/`follow_up` dedicated calls** — switch from prompt-piggyback to
   the documented methods once the harness layer exists (pi keeps both).
9. **`get_last_assistant_text`** — retry/quote UX polish.
10. **Linux portability** — taskkill/where.exe/pi.cmd shim/tasklist paths in
    pi.rs/pimgr.rs need POSIX twins (killpg, PATH resolution, node entry
    discovery), NSIS→deb/AppImage in the release pipeline, GTK stack audit
    (see AUDIT-2026-09-17.md: glib RUSTSEC alert is blocked on upstream).

## Process items to discuss (not unilateral)

- **dependabot.yml** (outward-facing): weekly ecosystem updates + glib
  tracking; the repo has open alerts but no config file.
- **SHA256SUMS** next to the installer in release artifacts (RELEASE.md
  already signs; a checksum file is cheap tamper-evidence).
- **cargo-about / license bundle** for the installer page.
- **marked 15 → 18, vite 6 → 8** upgrades: pending in npm outdated; batch
  them with the next dependency sweep, not mid-hardening.
- **Review-agent verification loop**: this round introduced the "fresh eyes
  re-review after fixes" loop; making it a standing step before each release
  tag would catch regressions the gate can't.
