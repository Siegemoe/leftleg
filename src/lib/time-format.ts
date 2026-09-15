// Shared time formatting for chat surfaces: compact durations for tool cards,
// thinking summaries and turn meta lines, plus "Today · 3:42 PM" day headers.

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function startOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/** "Today · 3:42 PM" / "Yesterday · 9:15 AM" / "Tue, Sep 9 · 11:03 PM". */
export function dayHeaderLabel(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const n = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dayDiff = Math.round((startOfDay(n) - startOfDay(d)) / 86_400_000);
  let day: string;
  if (dayDiff <= 0) day = "Today";
  else if (dayDiff === 1) day = "Yesterday";
  else {
    const sameYear = d.getFullYear() === n.getFullYear();
    day = d.toLocaleDateString(
      [],
      sameYear
        ? { weekday: "short", month: "short", day: "numeric" }
        : { weekday: "short", month: "short", day: "numeric", year: "numeric" },
    );
  }
  return `${day} · ${time}`;
}

/** Local-midnight bucket used to group items into day sections. */
export function dayKey(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return "";
  return new Date(ts).toDateString();
}
