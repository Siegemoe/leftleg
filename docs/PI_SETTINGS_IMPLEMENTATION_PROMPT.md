# Implementation prompt: full Pi configuration from Leftleg Settings

Implement a comprehensive Settings workspace in Leftleg so I can configure the Pi installation and extensions I actually use without leaving the GUI. Read `C:/dev/active/pi-agent-gui/AGENTS.md` and `C:/dev/active/pi-agent-gui/docs/PI_SETTINGS_INVENTORY.md` first. This is an implementation task: inspect, implement, and verify; do not stop at a plan or a decorative settings mockup.

## Outcome, boundaries, proof

**Success:** every discovered, user-configurable Pi or installed-extension option has a truthful control or an explicitly identified advanced editor, correct scope, source/default information, real persistence, and an accurate apply/reload/restart state. I can find and change configuration without memorizing slash commands or file locations. Unknown future extensions remain discoverable without pretending their custom UIs automatically work.

**Failure:** a control writes only Leftleg state, a project override is saved but silently ignored, a TUI command becomes an LLM prompt, a secret appears in the transcript/logs, or a save/reload silently stops work. A button that looks enabled but has no working integration is a failure.

**Proof:** tests against the installed Pi interfaces in isolated configuration directories, round-trip persistence and inheritance checks, mounted UI interactions, and a Settings smoke test. Demonstrate one real setting change being saved and observed by Pi; mocks alone are insufficient. Keep configuration changes made for tests out of my real Pi directory.

Exclude operational session management: creating/opening/renaming/deleting/cloning/exporting sessions, forking, compaction execution, aborting retries, undo/redo, task execution/attachment/killing, goal start/stop, plan approval, and worktree creation/switching/deletion belong in their existing operational menus or future dedicated surfaces. Their configuration defaults, storage locations, policies, model choices, and integration health do belong in Settings. Move existing misplaced controls without deleting their functionality. Current model/thinking can remain as an explicitly labeled current-runtime section, alongside distinct saved defaults.

Preserve unrelated work, especially existing font/theme changes. Pi owns agent configuration, credentials, tools, resources, and execution. Leftleg owns presentation and necessary launcher preferences. Do not build another model registry, transcript database, agent settings store, or memory engine in GUI state.

## Establish the real capability contract first

The inventory examined Pi **0.85.1** and 14 configured packages plus two Distill-contributed extensions. Re-resolve the executable, agent directory, package locations, versions and selected project before implementation. Read installed documentation and actual handlers/types, not old package examples. Distinguish installed, enabled by configuration, eligible under trust, successfully loaded, and currently active. Do not start extra extension workers or provider calls just to populate a settings screen.

Create a versioned capability/setting descriptor model. Each setting needs: stable ID; owner; label/help/search keywords; type/enum/range; documented default or explicit unknown; supported scopes; raw scoped value; effective saved value; known live value; source path/override reason; secret/read-only status; read/write adapter; validation; and effect timing (immediate, next call/turn/session, resource reload, worker restart, or Pi restart). Record a source reference for implemented adapters. Missing is not false/zero; absent configuration uses inheritance. A disabled control explains why.

There is **no native general get_settings/set_settings RPC in this Pi version**. Implement the missing integration, not invented RPC names:

1. Use native RPC where it exists and verify its persistence semantics. In this version `set_model`/`set_thinking_level` are session choices; queue modes and compaction/retry switches also persist via SettingsManager. Do not use a global-persisting setter for a control labeled project-only.
2. For missing operations, build a small, versioned **Pi companion extension** with a deliberate management contract, loaded independently of project trust. Keep the normal agent integration over Pi RPC. The extension can use supported Pi exports/configuration resolvers and explicit versioned adapters for installed extensions.
3. One viable transport is a reserved registered extension command invoked directly through RPC, with request-correlated, validated structured replies carried by a supported extension UI event. This is a proposed Leftleg protocol, not a native Pi feature. Prove the handshake, result/error delivery, cancellation, and lifecycle before building the forms. Never emit unframed debug text onto stdout.
4. Management requests must bypass `sendPrompt`'s chat-item construction and never become model messages, saved conversation entries, or billable turns. Do not use `sendMessage` as a hidden persistent response bus. Validate operation names and payloads in the companion; command availability and process-generation checks must prevent fallback to an ordinary model prompt when the companion is absent/reloading. A successful `prompt` acceptance is not proof the settings operation succeeded.
5. Public extension capabilities include tool enumeration/activation, effective prompt/trust inspection, model-registry refresh, and command-context reload. Public SettingsManager/ModelRuntime APIs may require their own correctly scoped instance; do not access private runtime fields or import obsolete AuthStorage examples. Native `/settings` and `/login` are not RPC endpoints. `ctx.ui.custom()` does not work in RPC even though `ctx.hasUI` is true.
6. Keep the companion recoverable when other extensions are disabled or broken. Provide explicit bootstrap/version diagnostics and a restricted repair path; do not enable all untrusted project extensions to make Settings work. Offline/file-backed configuration should remain accessible when an agent/provider is unavailable, using the same adapters rather than requiring a paid model turn.

If a public interface cannot safely support an operation, implement the narrow missing management capability or a properly labeled native-file editor; do not silently drop the control, mark a TODO as supported, or redesign Pi's harness. Any unavoidable unsupported capability must appear in the final coverage report.

## Settings interaction model

Use a roomy settings page/panel with a searchable category rail, not more cards squeezed into the current small modal. Categories: Models & Providers; Agent Behavior; Tools & Shell; Extensions; Skills & Prompts; Trust & Permissions; Appearance & TUI; Advanced & Diagnostics. Project presentation preferences can remain a separate GUI category.

- Prominent scope selector: Global / Selected project / Current runtime when supported. Selecting an editing scope must not switch conversations or the active Pi process. Explicitly name the target project and agent directory.
- Search across setting names, descriptions, extension names, and underlying keys. Deep-link to controls; include modified-only filtering and clear reset/inherit actions.
- Show effective value and its source, including when a saved project value is ignored by trust or superseded by environment/CLI. Separate Pi defaults, saved overrides, unsaved form edits, and loaded runtime values.
- Use natural controls for common options: switches, numeric inputs with units, searchable model pickers, ordered lists, rule editors, path pickers, and scoped resource lists. Advanced JSON/YAML/Markdown editors cover complete schemas without burying the useful controls.
- Use explicit Apply/Discard for multi-field edits; do not autosave half-written URLs, JSON, model IDs, or secrets. Disable duplicate submissions and preserve edits after errors. Prevent scope changes/closing from silently discarding unsaved changes.
- After a save, read back through the authoritative resolver. Report Saved, Applied, Pending reload/restart, or Failed independently. An unavailable effective-runtime value is unknown, not a guessed success.
- Global edits identify affected running projects. Apply/reload only at a safe boundary; never abort an active turn, queue, permission dialog, subagent, or background task to save a preference. Let me defer restart. Preserve/resume the same Pi session when restarting and expose any extension state that cannot survive it.

## Required coverage

### Models, providers and authentication

Expose Pi's current model/thinking separately from global/project startup provider/model/thinking, per-model thinking defaults, cycling scope (`enabledModels`), and supported thinking budgets. Obtain model capabilities and available thinking levels dynamically; do not hard-code an incomplete enum or cut the model list off at 80 entries. Preserve identifiers containing slashes/colons and OpenRouter `:free` suffixes.

Provide provider configuration, authentication status/source, supported login/logout/key replacement, custom model/provider creation/edit/removal, model overrides, endpoints, API type, input capabilities, reasoning, context/output limits, costs, headers, and compatibility options supported by the installed `models.json` schema. Include validated advanced fields so uncommon provider features remain configurable. Distinguish configured models from currently usable/authenticated models; refresh the actual model registry after changes.

Keep credentials in Pi's supported credential mechanism and preserve existing OpenRouter OAuth. Mask existing values; support deliberate replacement/removal without reading secrets back into normal form state, diagnostics, URLs, process arguments, logs, or transcripts. Preserve command/env references without evaluating them during display or validation. Do not offer a raw auth-file editor that exposes refresh tokens. OAuth interaction must use the installed provider flow, with cancellation and visible failure. Network tests are explicit actions, never hidden paid model prompts.

Remove hard-coded model forcing that overrides a deliberate saved Pi default. Migrate existing Leftleg project defaults/retry preferences only when they represent a saved user choice and the Pi destination is unambiguous. Preserve existing Pi values on conflicts and show the choice. GLM via OpenRouter remains the documented stack fallback when no user choice exists; do not change it arbitrarily.

### Agent behavior and reliability

Cover all installed core settings: compaction enabled/reserve/recent-token thresholds; branch-summary reserve and prompt preference; agent retry enabled/count/backoff; provider timeout/retry count/max delay; steering/follow-up delivery; transport and HTTP/WebSocket timeouts; image resizing/blocking; cache/diagnostic notices; supported thinking budgets. Include exact defaults, units, ranges, and meaningful zero semantics from source. Separate agent retries from provider retries. Do not invent unsupported generation knobs such as a universal temperature setting.

### Tools, shell and launch configuration

Show registered/active tools with name, description, owner/source when available, built-in versus extension status, and gating/override reasons. Configure startup built-ins and deliberate current-runtime tool selection; expose advanced allow/exclude behavior with its actual semantics. Disabling a built-in through `defaultTools` must not be presented as disabling every extension tool. Extension plan/permission gating can change effective availability; show it rather than fighting it with repeated forced activation.

Expose shellPath, shellCommandPrefix, npmCommand as argv, external editor, relevant environment overrides, and runtime/binary paths. Pi 0.85.1 includes native PowerShell; the installed pwsh adapter replaces the bash compatibility tool and shares routing with background tasks. Display the effective shell and owner instead of promising a generic Bash setting changes the adapter.

Support relevant launch-only flags: resource discovery toggles, tool filters, context/system-prompt flags, offline/version checking, directory overrides, and installed extension flags. Keep RPC mode/framing under Leftleg's control. Do not expose arbitrary mode/output switches that would break the bridge. Where Pi has canonical config, use it; only parameters without native storage may use explicitly documented launcher preferences. Do not overwrite machine-wide environment variables. Show environment source, override/unset semantics, and restart requirements; never persist secrets in ordinary GUI-state JSON.

### Extensions and their actual options

Build an installed-resource manager with version/source, enablement per supported scope, package-contributed extension/skill/prompt/theme entries, load errors, compatibility, and actual settings. Include add/install/remove/update/version pinning supported by Pi package management, with explicit user actions, visible progress/errors, safe argument arrays, and an honest pending-reload state. Preserve package resource filters and direct file resources; enabling/disabling must be reversible without deleting source code. Do not automatically install/update packages just by opening Settings.

Implement native forms/adapters for **every package row in the inventory**, including the two transitive Distill extensions. In particular:

- **Serena:** bridge environment and underlying global/project YAML; effective language/tool/backend config and worker diagnostics/restart. Do not hide existing advanced YAML fields or overwrite comments.
- **Lens:** all check switches, include/exclude patterns, concurrency/delays/timeouts/reporting and its separate TUI renderer switch.
- **Plan:** plan model/thinking, fallback model chain, BTW model, goal evaluator and turn cap, plans directory. Trace `goalModel` versus `goal.model` precedence. Its current preference writer replaces the pi-plan namespace: prove editing planModel cannot erase btw/goal/plansDir fields. Handle this boundary explicitly rather than blindly invoking the TUI saver.
- **Subagent:** role fallback chains, per-agent model overrides, supported agent-definition fields, auto-review, Herdr routing, inactivity/hard limits, project-agent and external-directory policies. The installed security resolver reads an undocumented ctx.settings property or environment variables; do not ship ineffective file-backed security toggles. Use a proven supported path and disclose timing/source. Configuration changes must not launch subagents.
- **Distill:** all fields from config.example.json plus per-tool enablement and render options. Separate agent-facing transformation from presentation; show current-model fallback and locale effects.
- **Web/Ref:** configured backends, endpoints, credential presence/replacement, private config references, timeouts/output limits and actual precedence. Keep secrets private.
- **Permissions:** ordered allow/ask/deny patterns, per-tool/global defaults, external-directory rules, and startup auto-approval flags. Last-match semantics must survive editing/reordering. Explain that yolo bypasses ask but not deny. Do not invent a doom-loop toggle or silently relax rules to make integrations pass.
- **Todo/background tasks:** all shared `99extensions.json` fields and namespaces, preserving unrelated namespaces. Distinguish model reminder frequency from widget appearance; no task operations here.
- **Worktrees/checkpoint/pwsh/session manager:** supported configuration, enablement and diagnostics only; do not invent settings for packages that have none.
- **i18n/tool display:** actual locale/config and all installed tool-display fields, including override ownership. Identify TUI-only rendering separately from agent/tool behavior. Do not pretend these options directly style Leftleg's webview.

Unknown extensions: discover resources and commands, surface any explicitly supplied schema/management adapter, otherwise offer their known configuration file/source/documentation and a validated advanced editor where appropriate. Never infer a configurable preference merely from a tool parameter, and never assume get_commands describes all tools, flags, or settings. Version-gate adapters; do not scrape private TUI component trees into forms.

### Skills, prompt templates and instruction sources

Inventory effective skills/templates/themes/extensions across global, project, package, and explicit-path sources. Show provenance, enabled/disabled/excluded state, trust blocking, collisions, and parse/load errors. Offer add/edit/disable/remove-resource controls, glob/exclusion editing, and skill-command registration. Package resources should use an explicit local override/copy or supported filter instead of editing installed node_modules that updates overwrite. Preserve frontmatter and linked resource files; expose those for editing without treating SKILL.md as the entire package.

Provide editors for actual Pi instruction sources: global/project SYSTEM.md and APPEND_SYSTEM.md, AGENTS.md/CLAUDE.md and AGENTS.override.md with ancestor provenance, resource paths, and launch prompt overrides. Explain replace versus append. Preview the real effective prompt through Pi where possible and label unknown extension-time injections; do not fabricate a full prompt by concatenating guessed files. Reflect reload timing. A file named USER.md is not automatically loaded by stock Pi: do not claim otherwise or introduce a memory-extraction system in this task.

### Trust, privacy, appearance and advanced controls

Expose Pi's effective project trust, global fallback policy and Pi-owned saved trust decisions. Selecting a folder for editing is not consent to trust its executable extensions. Show ignored project settings and provide an explicit trust action, preserving path/parent semantics. Keep this separate from pi-permission rules and subagent approvals. No automatic trust escalation during bootstrap.

Expose install telemetry, analytics, update checking/offline controls and provider warnings as distinct options. Internal tracking IDs/cache/changelog metadata should be inspectable only as needed and not casual mutable settings.

Keep Leftleg theme/fonts/icons/notifications separate from **Pi TUI preferences**. Include the TUI-only options from the full installed Settings type, terminal capabilities, rendering, fullscreen behavior, keybindings and custom themes; label that they affect terminal Pi rather than Leftleg. Existing GUI appearance work is outside this implementation except organization of settings.

Advanced includes validated editors for supported native configs, session storage _configuration_ (not session management), discovered relevant CLI/env options, resource diagnostics, and build identity: running Leftleg version/build revision/executable path plus actual Pi executable/version/agent directory. This must help detect an installer launching an older binary. Do not edit generated model caches, OAuth internals, checkpoint state, or transcripts as configuration.

## Persistence and lifecycle requirements

- Use canonical Pi/extension files and supported serializers. Patch the selected field/scope, preserve unknown fields, nested siblings, rule ordering and unrelated namespaces. Preserve JSON/YAML/Markdown formats appropriately; do not rewrite whole files from an incomplete form schema.
- Reset/inherit removes the override; it does not write the inherited value into the wrong scope. Respect per-extension merge rules and global-only fields. Never save the merged effective view wholesale back into global config.
- Validate before mutation. Invalid files produce a visible repairable error; do not overwrite them with defaults. Use atomic writes and Pi-compatible locking where available. Detect stale edits/concurrent external writes with revision checks and conflict handling; same app write serialization alone does not protect against the Pi TUI editing the same file.
- Track saved state separately from active state. On partial persistence/reload failure, state exactly what succeeded; do not give a generic green toast. Reload/multi-process propagation must be generation-aware, await results, refresh commands/models/tools, and retain clear pending states for unaffected processes.
- Reserve the management channel for deliberate GUI actions, not an LLM-callable tool that grants itself trust or edits credentials. Redact sensitive payloads at every logging/error boundary. Reject arbitrary file targets/operations outside the requested registered config resource.

## Delivery sequence and acceptance

Start with a compact coverage matrix (setting/owner/scope/source/default/read/write/effect/support/test). Then implement the management bridge and prove an isolated round trip; implement core settings and ownership migration; add package-specific adapters/resources; complete UI, lifecycle handling and verification. Continue through the full authorized scope; do not stop after the first few tabs.

Required tests/scenarios:

1. Global retry count + project override + Reset to inherit, preserving adjacent provider retry settings; external concurrent edit produces a conflict rather than lost data.
2. Current-model switch leaves startup defaults unchanged; saved defaults survive a fresh Pi process; old Leftleg defaults cannot silently overwrite the chosen Pi settings.
3. Project config under untrusted RPC is visibly saved-but-ignored; explicit trust activation changes effective state as documented without granting broad trust silently.
4. A native setter with global persistence cannot accidentally implement a project-only control. Missing/invalid configs and unknown keys survive unrelated edits.
5. Toggle one extension/resource without losing its configuration or sibling package resources; handle a load error and preserve companion access. Prove native TUI commands never reach the LLM as management requests.
6. Tool selection reflects built-in versus extension semantics and PowerShell adapter ownership; toggling display settings does not falsely claim an agent tool was disabled.
7. Plan settings preserve utility fields; Todo/background shared saves preserve both namespaces; subagent role parsing preserves OpenRouter identifiers; security controls demonstrably affect the real resolver.
8. Provider/key/OAuth cancellation, failure and replacement preserve existing credentials appropriately; sensitive data never enters GUI persistence, transcript, logs or command-line args. Model-list refresh observes a saved custom provider without editing models-store.json.
9. Skill/template/instruction changes preserve metadata and show true reload/provenance state. Search finds core and extension controls. Scope changes, discard, validation and pending-restart UI work with keyboard input.
10. Saving a restart-required field during active work does not interrupt it. Global changes identify stale running processes; a deferred restart retains the intended session and refreshes actual configuration.

Use an isolated PI_CODING_AGENT_DIR, temporary project, fixture credentials and harmless test extensions for integration checks. Do not consume real API credits or install/uninstall real user packages as a test side effect. Include mounted Svelte tests; avoid tests that merely compare duplicated hard-coded defaults.

Run `npm run build` (zero svelte-check errors/warnings, Vitest passing). For Rust changes run `npm run check:rust`, and relevant `npm run test:rust` coverage for parsing/framing/config file operations. Exercise the real Settings UI where available; report unavailable desktop/provider verification honestly. Do not commit, push, build/install a release, or change my live Pi configuration unless separately requested through an actual settings action.

Finish with the implemented coverage matrix, checks run, and explicit remaining limitations. Report full coverage only when every discovered user-configurable field is implemented, deliberately classified as advanced/TUI-only, or visibly documented as unsupported with a concrete reason.
