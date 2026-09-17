// Startup pi-harness/extension updater (user-accepted risk: pi updates
// itself via `pi update --all` on our behalf). Debounced, never blocks boot,
// and gated by a read-only integrity check: unregistered (non-npm-registry)
// extension sources hold the auto-update for that run and raise a warning —
// belt-and-braces on top of the risk acceptance.
import { get } from "svelte/store";
import { pushNotification, setGuiStateValue, guiStateValue, streaming, updateInstallLock } from "./stores";
import { piIntegrityReport, runPiManager } from "./api";

/** At most one managed update attempt per 12 hours. */
const UPDATE_DEBOUNCE_MS = 12 * 60 * 60 * 1000;

let inFlight = false;

function lastRunMs(): number {
  const v = guiStateValue("piUpdateLastRun");
  return typeof v === "number" ? v : 0;
}

/** Parse "pkg x.y.z → a.b.c" style upgrade lines out of pi's human output. */
export function summarizeUpdateOutput(out: string): string[] {
  const upgraded: string[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (/→|->/.test(line) && /\d+\.\d+/.test(line)) upgraded.push(line);
  }
  return upgraded;
}

/** Integrity gate: every configured extension source must be an npm-registry
 * spec. Local-file or git sources are unclassifiable from here, so updates
 * are held and the user is told why. Unreadable config counts as a pass —
 * pi's own installer verification remains the safety net. */
export async function integrityGate(): Promise<{ ok: boolean; flagged: string[] }> {
  try {
    const report = await piIntegrityReport();
    const flagged = report.extensions.filter((e) => !e.trusted).map((e) => e.source);
    return { ok: flagged.length === 0, flagged };
  } catch {
    return { ok: true, flagged: [] };
  }
}

/**
 * Fire-and-forget startup pass: skip while anything streams or an app update
 * is installing, debounce to once/12h, gate on integrity, then run
 * `pi update --all` and surface the outcome as a notification.
 */
export function runStartupPiUpdate(): void {
  void (async () => {
    if (inFlight) return;
    if (get(streaming) || get(updateInstallLock)) return;
    if (Date.now() - lastRunMs() < UPDATE_DEBOUNCE_MS) return;
    inFlight = true;
    try {
      const gate = await integrityGate();
      if (!gate.ok) {
        // Hold updates for flagged sources — but warn on every startup so the
        // situation can't be forgotten. No debounce stamp on this path.
        pushNotification(
          "warning",
          `pi auto-update held: unregistered extension source(s) — ${gate.flagged.join(", ")}`,
        );
        return;
      }
      // Re-check right before the npm pass: the integrity gate awaited, and a
      // turn may have started or the app updater may have taken the lock in
      // that window — rewriting the npm package under live pi is the one thing
      // this runner must never do.
      if (get(streaming) || get(updateInstallLock)) return;
      const res = await runPiManager(["--all"]);
      await setGuiStateValue("piUpdateLastRun", Date.now());
      const upgraded = summarizeUpdateOutput(res.stdout);
      if (res.exitCode === 0) {
        if (upgraded.length > 0) {
          pushNotification("info", `pi updated: ${upgraded.length} package(s) — restart pi to pick them up`);
        }
      } else {
        pushNotification("error", `pi update failed (exit ${res.exitCode}) — see Leftleg logs`);
      }
    } catch (e) {
      pushNotification("error", `pi update couldn't run: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight = false;
    }
  })();
}
