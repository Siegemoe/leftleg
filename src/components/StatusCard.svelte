<script lang="ts">
  // Status card: session todos + pi module. Lives inside the right panel
  // (extracted from the old TitleBar dropdown; the app-updates section was
  // dropped as redundant with the title-bar banner + Settings → Updates).
  import { piRequest, piModuleInfo, piIntegrityReport } from "../lib/api";
  import type { AgentMessage } from "../lib/types";
  import { activeSessionPath, lastProcByProject, projectDir } from "../lib/stores";

  interface TodoTask {
    key: string;
    status: string;
    subject: string;
  }

  let todos = $state<TodoTask[] | null>(null);
  let todosLoaded = $state(false);
  let piInfo = $state<{ name: string; version: string } | null>(null);
  let integrity = $state<{ extensions: { source: string; trusted: boolean }[] } | null>(null);
  let revision = 0;

  // The task list is the latest `todo` tool call in the session — scan the
  // transcript backwards for its arguments. Re-runs when the owning
  // project/session/process changes; a stale response is dropped via the
  // revision counter.
  $effect(() => {
    const ownerProject = $projectDir;
    // Session switches (same project) swap the transcript get_messages reads —
    // stay a dependency even though the fetch is project/process-scoped.
    void $activeSessionPath;
    const ownerProc = $lastProcByProject[ownerProject];
    const rev = ++revision;
    todos = null;
    // Pi identity and extension integrity are project-independent global
    // reads — they must keep resolving at the start view too, or those two
    // sections spin forever. (They still re-run with the effect's deps, so a
    // project change refreshes them like before; a stale response is dropped
    // via the revision counter, like the todos fetch.)
    void (async () => {
      try {
        const info = await piModuleInfo();
        if (rev === revision) piInfo = info;
      } catch {
        if (rev === revision) piInfo = null;
      }
    })();
    void (async () => {
      try {
        const report = await piIntegrityReport();
        if (rev === revision) integrity = report;
      } catch {
        if (rev === revision) integrity = null;
      }
    })();
    // The Status dock is openable at the start view; with no owner project
    // there is no session to scan and the fetch would resolve against the
    // backgrounded project's process — render the empty state instead.
    if (!ownerProject) {
      todosLoaded = true;
      return;
    }
    todosLoaded = false;
    void (async () => {
      try {
        const res = await piRequest<{ success: boolean; data?: { messages: AgentMessage[] } }>(
          { type: "get_messages" },
          60,
          ownerProject || null,
          ownerProc,
        );
        const msgs =
          res.success && Array.isArray(res.data?.messages)
            ? (res.data!.messages as AgentMessage[])
            : [];
        let found: TodoTask[] | null = null;
        for (let i = msgs.length - 1; i >= 0 && !found; i--) {
          const content = msgs[i].content;
          const blocks = Array.isArray(content) ? content : [];
          for (let j = blocks.length - 1; j >= 0; j--) {
            const b = blocks[j];
            const blk = b as { type?: string; name?: string; arguments?: { tasks?: unknown } };
            if (
              blk.type === "toolCall" &&
              blk.name === "todo" &&
              blk.arguments &&
              Array.isArray(blk.arguments.tasks)
            ) {
              found = (blk.arguments.tasks as TodoTask[]).map((t) => ({
                key: String(t.key ?? ""),
                status: String(t.status ?? "pending"),
                subject: String(t.subject ?? t.key ?? ""),
              }));
              break;
            }
          }
        }
        if (rev === revision) todos = found ?? [];
      } catch {
        if (rev === revision) todos = [];
      }
      if (rev === revision) todosLoaded = true;
    })();
  });
</script>

<div class="statuscard">
  <section>
    <h4>Todos</h4>
    {#if !todosLoaded}
      <p class="dim">Loading…</p>
    {:else if !todos || todos.length === 0}
      <p class="dim">No task list in this session yet.</p>
    {:else}
      <div class="tsum">
        {todos.filter((t) => t.status === "completed").length}/{todos.length} done
      </div>
      {#each todos as t (t.key)}
        <div class="task">
          <span class="st {t.status}"
            >{t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}</span
          >
          <span class="subj" class:done={t.status === "completed"}>{t.subject}</span>
        </div>
      {/each}
    {/if}
  </section>
  <section>
    <h4>Pi module</h4>
    {#if piInfo}
      <p class="dim mono">{piInfo.name} v{piInfo.version}</p>
    {:else}
      <p class="dim">Resolving the pi install…</p>
    {/if}
  </section>
  <section>
    <h4>Extensions</h4>
    {#if integrity}
      {@const flagged = integrity.extensions.filter((e) => !e.trusted)}
      {#if flagged.length === 0}
        <p class="dim">{integrity.extensions.length} installed · all npm-registry sources</p>
      {:else}
        <p class="dim warn">⚠ {flagged.length} unregistered source(s) — updates held</p>
        {#each flagged as f (f)}
          <p class="dim mono">{f}</p>
        {/each}
      {/if}
    {:else}
      <p class="dim">Checking extension sources…</p>
    {/if}
  </section>
</div>

<style>
  .statuscard {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 14px 10px;
    display: flex;
    flex-direction: column;
  }
  .statuscard section {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .statuscard section:last-child {
    border-bottom: none;
  }
  .statuscard h4 {
    margin: 0 0 6px;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-3);
  }
  .dim {
    color: var(--text-3);
    font-size: 12px;
    margin: 2px 0;
  }
  .warn {
    color: var(--danger);
  }
  .tsum {
    font-size: 11px;
    color: var(--text-3);
    margin-bottom: 4px;
  }
  .task {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 0;
    font-size: 12.5px;
  }
  .st {
    width: 14px;
    text-align: center;
    flex-shrink: 0;
  }
  .st.completed {
    color: var(--ok);
  }
  .st.in_progress {
    color: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .st.pending {
    color: var(--text-3);
  }
  .subj {
    color: var(--text-2);
  }
  .subj.done {
    color: var(--text-3);
    text-decoration: line-through;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
</style>
