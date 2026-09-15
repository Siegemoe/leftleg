import { describe, expect, it } from "vitest";
import { dayHeaderLabel, dayKey, formatDuration } from "./time-format";

describe("formatDuration", () => {
  it("formats sub-second and short durations with one decimal", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(1200)).toBe("1.2s");
  });

  it("formats 10s-60s without decimals", () => {
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(59_900)).toBe("60s");
  });

  it("formats minutes", () => {
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(600_000)).toBe("10m 00s");
  });

  it("rejects invalid input", () => {
    expect(formatDuration(-5)).toBe("");
    expect(formatDuration(NaN)).toBe("");
  });
});

describe("dayHeaderLabel", () => {
  const now = new Date(2026, 8, 15, 22, 0, 0).getTime(); // Tue Sep 15 2026 22:00 local

  it("labels same-day timestamps as Today", () => {
    const ts = new Date(2026, 8, 15, 15, 42, 0).getTime();
    const label = dayHeaderLabel(ts, now);
    expect(label.startsWith("Today")).toBe(true);
    expect(label).toContain("3:42");
  });

  it("labels the previous calendar day as Yesterday", () => {
    const ts = new Date(2026, 8, 14, 9, 15, 0).getTime();
    expect(dayHeaderLabel(ts, now).startsWith("Yesterday")).toBe(true);
  });

  it("labels older timestamps with weekday and date", () => {
    const ts = new Date(2026, 8, 9, 23, 3, 0).getTime();
    const label = dayHeaderLabel(ts, now);
    expect(label).not.toContain("Today");
    expect(label).not.toContain("Yesterday");
    expect(label).toContain("Sep 9");
    expect(label).toContain("11:03");
  });

  it("includes the year for other-year timestamps", () => {
    const ts = new Date(2025, 0, 6, 8, 0, 0).getTime();
    expect(dayHeaderLabel(ts, now)).toContain("2025");
  });

  it("rejects invalid input", () => {
    expect(dayHeaderLabel(NaN, now)).toBe("");
  });
});

describe("dayKey", () => {
  it("buckets by local calendar day and rejects undefined", () => {
    const a = new Date(2026, 8, 15, 1, 0, 0).getTime();
    const b = new Date(2026, 8, 15, 23, 0, 0).getTime();
    expect(dayKey(a)).toBe(dayKey(b));
    expect(dayKey(undefined)).toBe("");
  });
});
