# CodeQL triage — 2026-09-19

Triage of the 105 CodeQL alerts opened when the CI pipeline was introduced
(all open, analyzed on the pipeline commit; flagged files are byte-identical
to the current tree). This doc is the working record for the queue: what is
real, what is noise, what gets fixed in code, and what gets dismissed with a
justification. Re-run triage from here after future CodeQL sweeps instead of
re-deriving it.

Key structural fact: **53 of the 80 Rust path-injection alerts (66%) plus 2
of the 3 command-line-injection alerts sit inside `#[cfg(test)] mod tests`
blocks** operating on in-test temp-dir fixtures — zero production exposure.
Totals: 46 production alerts, 59 test-or-fixture alerts.

## Inventory (rule × file × count)

| Rule                             | Sev      | File                                  | Count | Prod / Test |
| -------------------------------- | -------- | ------------------------------------- | ----- | ----------- |
| `rust/path-injection`            | high     | `src-tauri/src/sessions.rs`           | 68    | 21 / 47     |
|                                  |          | `src-tauri/src/pi.rs`                 | 7     | 1 / 6       |
|                                  |          | `src-tauri/src/lib.rs`                | 4     | 4 / 0       |
|                                  |          | `src-tauri/src/pimgr.rs`              | 1     | 1 / 0       |
| `js/path-injection`              | high     | `companion/leftleg-settings/index.ts` | 18    | 18 / 0      |
|                                  |          | `companion/leftleg-media/index.ts`    | 1     | 1 / 0       |
| `rust/command-line-injection`    | critical | `src-tauri/src/pi.rs`                 | 2     | 0 / 2       |
|                                  |          | `src-tauri/src/sessions.rs`           | 1     | 1 / 0       |
| `js/file-system-race`            | high     | `companion/leftleg-media/index.ts`    | 1     | 1           |
| `js/file-access-to-http`         | medium   | `companion/leftleg-media/index.ts`    | 1     | 1           |
| `js/prototype-pollution-utility` | medium   | `src/lib/settings/state.ts`           | 1     | 1           |

## The three critical command-line-injection alerts

- `pi.rs:510` and `pi.rs:599` — **false positives, test-only.** Both sit in
  `#[cfg(test)] mod tests` (pi.rs:476+); the flagged values are temp-dir
  fixtures the tests synthesize lines earlier. Sinks are argv-array spawns
  (`Command::new("node").args(...)`), no shell.
- `sessions.rs:635` (`run_git_bytes` → `cmd.arg("-C").arg(dir)`) — **real
  gap, one-line fix.** Not classic shell injection (argv is fixed and Rust
  escapes argv on Windows), but the value controls _which directory git runs
  in_, and the taint source is a webview-supplied `project_dir` string:
  `git_repo_info` passes the renderer string straight through with no
  `project_dir_allowed` gate, unlike its siblings (`git_diff_summary`,
  `repo_files`, `file_stats_batch`, `read_text_file` all validate). Running
  git in an attacker-chosen directory enables config-driven execution
  (`core.fsmonitor` spawns on `git status`; textconv drivers on `git diff`)
  plus a repo-content probe.

## Code fixes (the only production gaps)

One shared helper, `project_dir_allowed` (sessions.rs:1042), fixes all of
them — each is a missing gate, one line each:

1. `git_repo_info` — add the gate (closes the real critical above).
2. `list_artifacts` — add the gate. **Highest-value gap in the set:** it also
   performs the unvalidated `scope.allow_directory(<proj>/.pi/images,
recursive)` grant (sessions.rs:601–616), the only production path here
   that hands the webview read access to a renderer-chosen directory tree.
3. `delete_artifact` — add the gate. Its per-file containment is real, but
   the project root is not checked, and delete is strictly more dangerous
   than the read commands the repo already gates.

Everything else in the Rust production set already passes through
`project_dir_allowed`, `resolve_in_project`, `companion_relative_path`, or
`path_containment_allowed` before its sink.

## Path-injection classes (Rust production)

| Class                                                        | Source                                                        | Alerts | Disposition                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| R1: agent-dir env resolution (`PI_CODING_AGENT_DIR`/`HOME`)  | user env, not webview-reachable                               | 6      | dismiss — the "taint" is the user's own env var                                               |
| R2: GUI-state atomic write (`app_data_dir` + fixed filename) | app-derived only                                              | 4      | dismiss — path fully determined by the app                                                    |
| R3: dialog-picked attachments                                | user-picked via native dialog (documented intent)             | 1      | accept as designed                                                                            |
| R4: unvalidated webview `project_dir`                        | free-typed webview string                                     | 5      | **fix** (gates above)                                                                         |
| R5: validated-then-reflowed project dir                      | validated before every sink                                   | 3      | dismiss with justification                                                                    |
| R6: `create_project_dir` parent                              | dialog-picked normally; free-typed from a compromised webview | 4      | keep accepted risk (documented: dirs-only creation, name validated, no containment on parent) |
| T1: test-region alerts (53)                                  | in-test temp fixtures                                         | 53     | dismiss — cannot path-exclude (inline `#[cfg(test)]` modules share the file)                  |

## Path-injection classes (JS, 19 alerts)

- **J1 (18): companion resource allowlist** — `resolveTarget`'s switch over
  hardcoded joins **is** the validation helper: the request string only
  selects a label, no path component survives into `join`. Dismiss with that
  as the justification. Sources are env/homedir-derived agent dir and the
  user-picked project dir, not the webview request.
- **J2 (1): media config read** — `readFileSync(join(agentDir, "extensions",
"leftleg-media", "config.json"))` from env; same rationale as R1. Dismiss.

## The three non-path alerts

- **#21 `js/file-system-race` (leftleg-media:165)** — low-severity TOCTOU
  between `statSync().size` and `readFileSync`. Cannot bypass the limit: a
  post-read re-check rejects oversized buffers and MIME sniffing gates
  content. Residual risk only: a swapped-in multi-GiB file is fully buffered
  before rejection. Optional hardening: read through an open+cap instead of
  stat-then-read. Accept for now.
- **#22 `js/file-access-to-http` (leftleg-media:291)** — intentional by
  design: reference images are sent as base64 data URLs to a hardcoded
  constant endpoint (`https://openrouter.ai/api/v1/images`), the documented
  feature. Dismiss as intentional design.
- **#20 `js/prototype-pollution-utility` (state.ts:33)** — false positive:
  `setPath` validates every segment against `isUnsafeConfigKey`
  (`__proto__`/`constructor`/`prototype`) immediately above the flagged
  line; call sites pass developer-authored config keys. Dismiss with the
  guard as justification.

## Disposition plan

1. **Fix in code** (one commit): gates for `git_repo_info`, `list_artifacts`,
   `delete_artifact`, plus negative tests. Those alerts then resolve as
   fixed.
2. **Dismiss with justification** (one sweep, after the fix lands so the
   justifications can reference it): T1 (53), J1 (18), J2 (1), R1 (6), R2
   (4), R5 (3), R7 (4, lib.rs `companion_relative_path` allowlist), #20,
   #22, and the two pi.rs test-only criticals.
3. **Keep open / accepted, documented**: R3 (dialog intent), R6 (accepted
   risk, documented at the call site), #21 (neutralized race; optional
   hardening).

Future sweeps: don't re-derive any of this. New alerts not matching a class
here deserve fresh eyes.

## Executed (2026-09-19)

The plan above was carried out as written:

1. **Fix in code** — "fix: gate the remaining webview-supplied project_dir
   commands" added `git_repo_info_checked`, `list_artifacts_checked`, and
   `delete_artifact_allowed` gates with an integration test
   (`src-tauri/tests/project_dir_gate.rs`); CodeQL's next master analysis
   closed 24 of the original inventory as fixed, including all 3
   command-line-injection alerts.
2. **Dismiss with justification** — the sweep dismissed 99 alerts, each with
   a comment citing its class above and referencing this doc: 75 from the
   original inventory plus 24 new alerts (numbers 106–129) that the
   post-merge analysis raised for the changed code, all of which fall under
   the already-triaged classes.
3. **Keep open** — 6 alerts remain open, exactly the accepted set: #21 (the
   neutralized `leftleg-media` race), #53 (R3 dialog-picked attachment), and
   #69/#95/#101/#102 (R6 `create_project_dir` parent directories). These are
   decisions, not an outstanding queue.

API-verified final state: 99 dismissed, 24 fixed, 6 open. The original
105-alert inventory accounts as 24 fixed + 75 dismissed + 6 open; the extra
24 dismissed came from the post-merge analysis of the new code.

## Evening remediation (2026-09-19) — the 6 keep-opens

All six accepted risks were closed in code the same day ("fix: remove the
webview-supplied project path and pin the media reads to their fd"):

- **#21 (`js/file-system-race`)** — `readReference` in
  `companion/leftleg-media/index.ts` now opens the file once and stats/reads
  through the same fd (`node:fs/promises` open → `fh.stat` → capped
  `fh.read`), so a swap-in between the size gate and the read can no longer
  slip an oversized file past the limit; the capped read bounds the buffer
  regardless.
- **#69/#95/#101/#102 (`rust/path-injection`, class R6)** — the
  webview-supplied-parent primitive is gone: `create_project_dir(parent,
name)` was replaced by `pick_and_create_project_dir(app, name)`, which
  opens the OS folder dialog in Rust (the `pick_and_read_files` pattern) and
  feeds the picked parent to the unchanged `create_project_dir_checked`
  validator. The webview sends only the folder name; no webview-supplied
  path reaches the create path anymore.
- **#53 (`rust/path-injection`, class R3)** — `read_attachment` canonicalizes
  the path and requires a regular file before opening. The remaining taint
  source is structural: the path genuinely comes from the user's own native
  dialog pick, not the webview. If the alert survives the master re-analysis
  on this code, it is dismissed with this remediation as the justification —
  accurate accounting, not silencing.

The next master analysis should mark #21 and the four R6 alerts fixed. The
open-alert target state is 0, or 1 (#53) pending the dismissal above.

## Final state (2026-09-20, API-verified)

The master re-analysis after the remediation closed the queue at **0 open
alerts**:

- **#21 (file-system-race)** — fixed: the fd-based read satisfied the query
  outright.
- **#53 (R3, read_attachment)** — fixed: canonicalize + regular-file check
  satisfied the query; no dismissal needed.
- **#69/#95/#101/#102 (R6)** — dismissed as "won't fix": the flagged
  locations inside `create_project_dir_checked` still exist (the validator
  is unchanged), so the analysis could not mark them fixed — but the
  webview-supplied-parent flow they described is gone
  (`pick_and_create_project_dir`), and each dismissal cites exactly that
  ("Parent comes from the OS folder dialog opened in Rust, never the
  webview; the webview sends only a validated folder name. Containing it
  further would defeat user-picked project folders.").
- Everything else keeps its earlier disposition (99 dismissed with class
  citations; 24+ marked fixed by the analyses).

CodeQL is at zero open. Nothing is an outstanding queue — the four R6
dismissals are documented decisions, not deferred work.

## Dependabot: the one open alert (glib)

Dependabot alert #1 (medium, GHSA-wrw7-89jp-8q8g): unsound `VariantStrIter`
iterators in `glib` 0.18.x (src-tauri/Cargo.lock). Assessed 2026-09-19;
left open deliberately:

- **No Windows exposure.** The vulnerable iterator API is reachable only
  inside gtk/glib code paths compiled for Linux targets (`cargo tree -i
glib` is empty on the Windows host; the gtk stack is target-gated), and
  Leftleg ships Windows installers.
- **No fix in range.** The advisory's only patched release is glib 0.20.0,
  a breaking major bump, and tauri's gtk 0.18 stack pins glib ^0.18 —
  nothing Leftleg controls can move it today.
- **Action:** none until Tauri moves to the gtk/glib 0.20 stack. Do not
  dismiss — the alert is an accurate statement about the Linux build;
  revisit on the next tauri dependency bump.
