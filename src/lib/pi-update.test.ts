import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // Minimal writable stand-in for the navigating store so tests can put the
  // app mid-navigation and let it settle again.
  const listeners = new Set<(v: boolean) => void>();
  let nav = false;
  const navigating = {
    subscribe: (fn: (v: boolean) => void) => { listeners.add(fn); fn(nav); return () => { listeners.delete(fn); }; },
    set: (v: boolean) => { nav = v; for (const l of listeners) l(v); },
  };
  return {
    piIntegrityReport: vi.fn(),
    runPiManager: vi.fn(),
    pushNotification: vi.fn(),
    setGuiStateValue: vi.fn(),
    guiStateValue: vi.fn(),
    collectUpdateInstallBlockers: vi.fn(),
    navigating,
  };
});

vi.mock("./api", () => ({
  piIntegrityReport: mocks.piIntegrityReport,
  runPiManager: mocks.runPiManager,
}));
vi.mock("./stores", () => ({
  pushNotification: mocks.pushNotification,
  setGuiStateValue: mocks.setGuiStateValue,
  guiStateValue: mocks.guiStateValue,
  collectUpdateInstallBlockers: mocks.collectUpdateInstallBlockers,
  navigating: mocks.navigating,
  updateInstallLock: { subscribe: (fn: (v: boolean) => void) => { fn(false); return () => {}; } },
}));

import { integrityGate, runStartupPiUpdate, summarizeUpdateOutput } from "./pi-update";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guiStateValue.mockReturnValue(0); // no debounce stamp
  mocks.collectUpdateInstallBlockers.mockReturnValue([]); // nothing in flight
  mocks.runPiManager.mockResolvedValue({ exitCode: 0, stdout: "" });
});

afterEach(() => {
  mocks.navigating.set(false); // module-level store — don't leak between tests
  vi.useRealTimers();
});

describe("summarizeUpdateOutput", () => {
  it("extracts upgrade lines with version arrows", () => {
    const out = [
      "Updating packages…",
      "pi-distill 1.0.0 → 1.1.0",
      "@bacnh85/pi-web 2.0.0 -> 2.1.0",
      "pi is up to date (0.85.1)",
      "",
    ].join("\n");
    expect(summarizeUpdateOutput(out)).toEqual([
      "pi-distill 1.0.0 → 1.1.0",
      "@bacnh85/pi-web 2.0.0 -> 2.1.0",
    ]);
  });

  it("returns nothing when already current", () => {
    expect(summarizeUpdateOutput("all packages up to date")).toEqual([]);
  });
});

describe("integrityGate", () => {
  it("passes when every source is npm-registry", async () => {
    mocks.piIntegrityReport.mockResolvedValue({
      extensions: [{ source: "npm:@foo/bar", trusted: true }, { source: "npm:pi-distill", trusted: true }],
    });
    expect(await integrityGate()).toEqual({ ok: true, flagged: [] });
  });

  it("flags non-registry sources", async () => {
    mocks.piIntegrityReport.mockResolvedValue({
      extensions: [
        { source: "npm:@foo/bar", trusted: true },
        { source: "./local/ext.ts", trusted: false },
        { source: "git:github.com/x/y", trusted: false },
      ],
    });
    const gate = await integrityGate();
    expect(gate.ok).toBe(false);
    expect(gate.flagged).toEqual(["./local/ext.ts", "git:github.com/x/y"]);
  });

  it("treats an unreadable report as a pass (pi verifies its own installs)", async () => {
    mocks.piIntegrityReport.mockRejectedValue(new Error("no settings"));
    expect(await integrityGate()).toEqual({ ok: true, flagged: [] });
  });
});

describe("runStartupPiUpdate", () => {
  it("holds the update and warns when the integrity gate flags sources", async () => {
    mocks.piIntegrityReport.mockResolvedValue({
      extensions: [{ source: "./local.ts", trusted: false }],
    });
    runStartupPiUpdate();
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.runPiManager).not.toHaveBeenCalled();
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("./local.ts"),
    );
    expect(mocks.setGuiStateValue).not.toHaveBeenCalled();
  });

  it("runs pi update --all, stamps the run, and reports upgrades", async () => {
    mocks.piIntegrityReport.mockResolvedValue({ extensions: [] });
    mocks.runPiManager.mockResolvedValue({
      exitCode: 0,
      stdout: "pi 0.85.1 → 0.86.0",
    });
    runStartupPiUpdate();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.runPiManager).toHaveBeenCalledWith(["--all"]);
    expect(mocks.setGuiStateValue).toHaveBeenCalledWith("piUpdateLastRun", expect.any(Number));
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("pi updated"),
    );
  });

  it("stays silent when everything is already current", async () => {
    mocks.piIntegrityReport.mockResolvedValue({ extensions: [{ source: "npm:x", trusted: true }] });
    mocks.runPiManager.mockResolvedValue({ exitCode: 0, stdout: "all up to date" });
    runStartupPiUpdate();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.pushNotification).not.toHaveBeenCalled();
  });

  it("reports a non-zero exit as an error", async () => {
    mocks.piIntegrityReport.mockResolvedValue({ extensions: [] });
    mocks.runPiManager.mockResolvedValue({ exitCode: 1, stdout: "boom" });
    runStartupPiUpdate();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("exit 1"),
    );
  });

  it("skips entirely while the debounce window is fresh", async () => {
    mocks.guiStateValue.mockReturnValue(Date.now() - 60_000); // ran a minute ago
    runStartupPiUpdate();
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.piIntegrityReport).not.toHaveBeenCalled();
    expect(mocks.runPiManager).not.toHaveBeenCalled();
  });

  it("skips while any project — including a background one — has activity", async () => {
    // Regression: the old foreground-only `streaming` check missed background
    // projects mid-turn; the npm pass must never run under live pi.
    mocks.collectUpdateInstallBlockers.mockReturnValue(["/b has an active agent turn"]);
    runStartupPiUpdate();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.piIntegrityReport).toHaveBeenCalled();
    expect(mocks.runPiManager).not.toHaveBeenCalled();
  });

  it("waits out an in-flight navigation instead of skipping, then runs", async () => {
    // navigatingSettled's wait only covers out-of-order callers (the
    // production call site fires post-boot); pin the wait mechanism anyway.
    mocks.piIntegrityReport.mockResolvedValue({ extensions: [] });
    mocks.runPiManager.mockResolvedValue({ exitCode: 0, stdout: "pi 0.85.1 → 0.86.0" });
    mocks.navigating.set(true); // navigation in flight at call time
    runStartupPiUpdate();
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.runPiManager).not.toHaveBeenCalled();
    mocks.navigating.set(false); // navigation settles
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.runPiManager).toHaveBeenCalledWith(["--all"]);
    expect(mocks.setGuiStateValue).toHaveBeenCalledWith("piUpdateLastRun", expect.any(Number));
  });

  it("skips without a stamp when navigation races in mid-pass (next launch retries)", async () => {
    // Regression for the round-2/round-3 starvation: the pass must NOT run
    // under navigation even when it already fast-pathed the wait — but the
    // skip leaves no debounce stamp, so the next launch retries. The
    // production call site is post-boot precisely so this race can't repeat
    // every launch.
    mocks.piIntegrityReport.mockImplementation(async () => {
      mocks.navigating.set(true); // navigation starts while the gate is in flight
      return { extensions: [] };
    });
    runStartupPiUpdate();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.runPiManager).not.toHaveBeenCalled();
    expect(mocks.setGuiStateValue).not.toHaveBeenCalled();
    expect(mocks.pushNotification).not.toHaveBeenCalled();
  });
});
