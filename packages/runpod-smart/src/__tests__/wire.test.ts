import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

describe("tools wire-up", () => {
  it("exports all 12 expected tools", () => {
    expect(tools).toHaveLength(12);
  });

  it("tool names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("tool names are snake_case", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("includes the expected tool set", () => {
    const expected = [
      "list_pods",
      "get_pod",
      "start_pod",
      "stop_pod",
      "terminate_pod",
      "launch_pod",
      "list_templates",
      "list_endpoints",
      "cost_audit",
      "daily_status",
      "spin_training_pod",
      "kill_idle_pods",
    ].sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });
});
