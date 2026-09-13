// Unit tests for the companion's pure file-patch semantics.
// These functions run inside the real Pi companion (companion/leftleg-settings).
import { describe, expect, it } from "vitest";
import { applyMerge, applyNamespaceMerge, applyNamespaces, resolveAgentDir, resolveTarget } from "../../../companion/leftleg-settings/index";

describe("companion applyMerge", () => {
  it("merges nested patches and preserves unknown siblings", () => {
    const base = {
      theme: "dark",
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      retry: { enabled: true, maxRetries: 3, provider: { timeoutMs: 3600000, maxRetries: 0, maxRetryDelayMs: 60000 } },
    };
    const next = applyMerge(base, { retry: { maxRetries: 5 } }) as typeof base;
    expect(next.retry.maxRetries).toBe(5);
    // adjacent provider retry settings survive
    expect(next.retry.provider).toEqual({ timeoutMs: 3600000, maxRetries: 0, maxRetryDelayMs: 60000 });
    expect(next.retry.enabled).toBe(true);
    expect(next.compaction).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(next.theme).toBe("dark");
  });

  it("arrays and scalars replace, objects merge recursively", () => {
    const base = { packages: ["a", "b"], nested: { keep: 1, list: [1, 2] } };
    const next = applyMerge(base, { packages: ["c"], nested: { list: [3] } }) as typeof base;
    expect(next.packages).toEqual(["c"]);
    expect(next.nested).toEqual({ keep: 1, list: [3] });
  });

  it("patching a missing base creates the object", () => {
    expect(applyMerge(null, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });

  it("explicit null clears a field rather than being ignored", () => {
    expect(applyMerge({ a: 1, b: 2 }, { a: null })).toEqual({ a: null, b: 2 });
  });
});

describe("companion applyNamespaces (replace mode)", () => {
  it("replaces the whole namespace; other namespaces survive", () => {
    const base = { "pi-plan": { planModel: "m1", goal: { model: "g" } }, theme: "dark" };
    const next = applyNamespaces(base, { "pi-plan": { planModel: "m2" } }) as typeof base;
    expect(next.theme).toBe("dark");
    expect(next["pi-plan"]).toEqual({ planModel: "m2" }); // replace semantics: editor must send the full namespace
  });
});

describe("companion applyNamespaceMerge (the Plan-safety primitive)", () => {
  it("editing planModel preserves btw/goal/plansDir inside pi-plan (scenario 7)", () => {
    const base = {
      "pi-plan": {
        version: 2,
        planModel: "openrouter/z-ai/glm-5.3-flash",
        planThinking: "high",
        goalModel: "openrouter/z-ai/glm-5.3-flash",
        fallbackModels: ["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"],
        btw: { model: "openrouter/mistralai/mistral-small-4-119b-2603" },
        goal: { model: "g", maxTurns: 5 },
        plansDir: "plans/{yyyymm}",
      },
      subagent: { roles: { coder: { models: ["openrouter/z-ai/glm-5.1", "openrouter/nvidia/nemotron-3-super-120b-a12b:free"] } } },
      theme: "dark",
    };
    const next = applyNamespaceMerge(base, { "pi-plan": { planModel: "openrouter/z-ai/glm-5.3-flash:high" } }) as typeof base;
    const plan = next["pi-plan"] as Record<string, unknown>;
    expect(plan.planModel).toBe("openrouter/z-ai/glm-5.3-flash:high");
    // utility fields survive the edit — the whole point of namespace-merge
    expect(plan.btw).toEqual({ model: "openrouter/mistralai/mistral-small-4-119b-2603" });
    expect(plan.goal).toEqual({ model: "g", maxTurns: 5 });
    expect(plan.plansDir).toBe("plans/{yyyymm}");
    expect(plan.fallbackModels).toEqual(["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"]);
    expect(next.theme).toBe("dark");
    // subagent role chains with OpenRouter identifiers untouched
    expect(next.subagent).toEqual(base.subagent);
  });

  it("subagent role editing preserves OpenRouter identifiers verbatim", () => {
    const base = { roles: { coder: { models: ["openrouter/z-ai/glm-5.1", "openrouter/nvidia/nemotron-3-super-120b-a12b:free"] } } };
    const next = applyMerge(base, { roles: { coder: { models: ["openrouter/z-ai/glm-5.1:medium"] } } }) as typeof base;
    expect(next.roles.coder.models).toEqual(["openrouter/z-ai/glm-5.1:medium"]);
  });
});

describe("companion targets", () => {
  it("resolves the allowlisted resources and rejects unknown ones", () => {
    const agentDir = resolveAgentDir();
    const project = "/work/demo";
    expect(resolveTarget("settings-global", agentDir, project)).toContain("settings.json");
    expect(resolveTarget("settings-project", agentDir, project)?.toLowerCase()).toContain(".pi");
    expect(resolveTarget("models-store", agentDir, project)).toContain("models-store.json");
    expect(resolveTarget("../etc/passwd", agentDir, project)).toBeNull();
    expect(resolveTarget("settings-project", agentDir, null)).toBeNull();
  });
});
