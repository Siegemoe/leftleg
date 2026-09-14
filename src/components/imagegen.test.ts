import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { ToolItem } from "../lib/types";

const mocks = vi.hoisted(() => ({
  readFileBase64: vi.fn(),
  listArtifacts: vi.fn(),
  deleteArtifact: vi.fn(),
}));

// Keep the rest of the real api module (only these three are exercised here).
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...mocks };
});

import ToolCard from "./ToolCard.svelte";
import Artifacts from "./Artifacts.svelte";
import { artifactsOpen, projectDir } from "../lib/stores";

const instances: ReturnType<typeof mount>[] = [];

afterEach(async () => {
  for (const i of instances.splice(0)) await unmount(i);
  document.body.replaceChildren();
  vi.clearAllMocks();
  artifactsOpen.set(false);
});

function baseItem(overrides: Partial<ToolItem>): ToolItem {
  return {
    kind: "tool",
    toolCallId: "tc1",
    name: "image_generate",
    args: JSON.stringify({ prompt: "a mug", aspect_ratio: "16:9" }),
    status: "running",
    output: "",
    outputTruncated: false,
    isError: false,
    ...overrides,
  };
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

describe("ToolCard image_generate rendering", () => {
  it("running state shows the animated placeholder with aspect ratio and progress, no <img>", () => {
    const item = baseItem({ output: "Rendering with google/gemini-3.1-flash-image… (typically 10-90s)" });
    instances.push(mount(ToolCard, { target: document.body, props: { item } }));
    flushSync();
    const ph = document.body.querySelector<HTMLElement>(".imgph");
    expect(ph).toBeTruthy();
    expect(ph!.style.getPropertyValue("--ph-ar")).toBe("16 / 9");
    expect(document.body.textContent).toContain("Rendering with google/gemini-3.1-flash-image");
    expect(document.body.querySelector("img")).toBeNull();
  });

  it("default aspect ratio applies when args carry none", () => {
    const item = baseItem({ args: JSON.stringify({ prompt: "a mug" }) });
    instances.push(mount(ToolCard, { target: document.body, props: { item } }));
    flushSync();
    const ph = document.body.querySelector<HTMLElement>(".imgph");
    expect(ph!.style.getPropertyValue("--ph-ar")).toBe("4 / 3");
  });

  it("malformed aspect_ratio falls back to the default instead of injecting CSS", () => {
    const item = baseItem({ args: JSON.stringify({ prompt: "a mug", aspect_ratio: "1); background: red" }) });
    instances.push(mount(ToolCard, { target: document.body, props: { item } }));
    flushSync();
    const ph = document.body.querySelector<HTMLElement>(".imgph");
    expect(ph!.style.getPropertyValue("--ph-ar")).toBe("4 / 3");
  });

  it("done state renders the inline image from details.paths", async () => {
    mocks.readFileBase64.mockResolvedValue("QUFB");
    const item = baseItem({
      status: "done",
      output: "Saved 1 image (m):\nC:\\i\\a.png\nReported cost: $0.0200",
      details: { paths: ["C:\\i\\a.png"], model: "m", usage: { cost: 0.02 }, references: 0 },
    });
    instances.push(mount(ToolCard, { target: document.body, props: { item } }));
    await settle();
    const img = document.body.querySelector<HTMLImageElement>(".imgbtn img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,QUFB");
    expect(document.body.textContent).toContain("m");
    expect(document.body.textContent).toContain("$0.0200");
  });

  it("falls back to parsing paths from the result text for history items", async () => {
    mocks.readFileBase64.mockResolvedValue("QUFB");
    const item = baseItem({
      status: "done",
      output: "Saved 1 image (m):\nC:\\i\\b.png\nReported cost: $0.0300",
    });
    instances.push(mount(ToolCard, { target: document.body, props: { item } }));
    await settle();
    const img = document.body.querySelector<HTMLImageElement>(".imgbtn img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,QUFB");
    expect(document.body.textContent).toContain("$0.0300");
  });

  it("oversized images render as an open chip, not an <img>", async () => {
    mocks.readFileBase64.mockResolvedValue("X".repeat(1_600_000));
    const item = baseItem({
      status: "done",
      details: { paths: ["C:\\i\\big.png"], model: "m" },
    });
    instances.push(mount(ToolCard, { target: document.body, props: { item } }));
    await settle();
    expect(document.body.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("too large to preview");
  });

  it("error state keeps the generic error presentation", () => {
    const item = baseItem({
      status: "error",
      isError: true,
      output: "OpenRouter images request failed (400): nope",
    });
    instances.push(mount(ToolCard, { target: document.body, props: { item } }));
    flushSync();
    const card = document.body.querySelector<HTMLElement>(".card");
    expect(card!.classList.contains("error")).toBe(true);
    expect(document.body.querySelector("img")).toBeNull();
    // The result text lives behind the expand toggle.
    const head = document.body.querySelector<HTMLButtonElement>(".head");
    head!.click();
    flushSync();
    expect(document.body.querySelector(".out.err")).toBeTruthy();
    expect(document.body.textContent).toContain("OpenRouter images request failed (400): nope");
  });
});

describe("Artifacts browser", () => {
  it("lists image tiles (with lazy thumbnail) and docs with exists flags", async () => {
    mocks.readFileBase64.mockResolvedValue("QUFB");
    mocks.listArtifacts.mockResolvedValue({
      images: [{ name: "a.png", path: "C:\\i\\a.png", size: 120, modifiedMs: Date.now(), exists: true }],
      docs: [
        { name: "AGENTS.md", path: "C:\\p\\AGENTS.md", size: 10, modifiedMs: 1, exists: true },
        { name: "SYSTEM.md", path: "C:\\p\\.pi\\SYSTEM.md", size: 0, modifiedMs: 0, exists: false },
        { name: "APPEND_SYSTEM.md", path: "C:\\p\\.pi\\APPEND_SYSTEM.md", size: 0, modifiedMs: 0, exists: false },
      ],
    });
    projectDir.set("/proj");
    artifactsOpen.set(true);
    instances.push(mount(Artifacts, { target: document.body }));
    await settle();

    expect(document.body.querySelector(".tile")).toBeTruthy();
    expect(document.body.textContent).toContain("a.png");
    await vi.waitFor(() => {
      expect(document.body.querySelector("img")).toBeTruthy();
    });

    const docsTab = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("Docs"));
    docsTab!.click();
    flushSync();
    expect(document.body.querySelectorAll(".docrow").length).toBe(3);
    const present = [...document.body.querySelectorAll(".docrow")].filter((r) => !r.classList.contains("missing"));
    expect(present.length).toBe(1);
    expect(present[0].textContent).toContain("AGENTS.md");
  });

  it("shows the empty state when the project has no images", async () => {
    mocks.listArtifacts.mockResolvedValue({ images: [], docs: [] });
    projectDir.set("/proj");
    artifactsOpen.set(true);
    instances.push(mount(Artifacts, { target: document.body }));
    await settle();
    expect(document.body.textContent).toContain("No generated images yet");
  });
});
