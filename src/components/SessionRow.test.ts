import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import SessionRow from "./SessionRow.svelte";
import type { SidebarPill, SidebarSession } from "../lib/sidebar-model";

const session: SidebarSession = {
  path: "C:/proj/.pi/agent/sessions/abc.jsonl",
  title: "Fix the login bug",
  projectDir: "C:/proj",
  timestampMs: 1_700_000_000_000,
  status: "active",
  pinned: false,
  settled: false,
  seen: true,
};

function rowProps(pill: SidebarPill | null) {
  return {
    session,
    pill,
    isActive: false,
    showProject: false,
    timeLabel: "5m",
    onopen: vi.fn(),
    onpintoggle: vi.fn(),
    onmenu: vi.fn(),
    onrenamecommit: vi.fn(),
    onrenamecancel: vi.fn(),
    onrenameinput: vi.fn(),
    ondragstart: vi.fn(),
    ondragend: vi.fn(),
    ondroprow: vi.fn(),
  };
}

let instance: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
});

describe("session row working chip", () => {
  it("renders the working chip right of the timestamp when the pill is working", () => {
    instance = mount(SessionRow, {
      target: document.body,
      props: rowProps({ kind: "working", label: "Working", pulse: true }),
    });
    flushSync();

    const chip = document.body.querySelector<HTMLElement>(".s-meta .working-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("working");
    expect(chip!.querySelector(".chip-dot")).not.toBeNull();
    // Placement: immediately right of the timestamp, before the spacer.
    expect(chip!.previousElementSibling?.classList.contains("s-time")).toBe(true);
    expect(chip!.nextElementSibling?.classList.contains("spacer")).toBe(true);
  });

  it("renders nothing for idle rows — no chip and no idle label", () => {
    instance = mount(SessionRow, { target: document.body, props: rowProps(null) });
    flushSync();

    expect(document.body.querySelector(".working-chip")).toBeNull();
    expect(document.body.textContent).not.toContain("idle");
  });

  it("renders no working chip for non-working pills", () => {
    instance = mount(SessionRow, {
      target: document.body,
      props: rowProps({ kind: "completed", label: "Completed", pulse: false }),
    });
    flushSync();

    expect(document.body.querySelector(".working-chip")).toBeNull();
    expect(document.body.textContent).toContain("Completed");
  });
});
