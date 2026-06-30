import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

// Wire test: the canary that proves all 17 tools land correctly. If a tool is
// added/removed/renamed, exactly one assertion below fires — by design. The
// count and the explicit name list both come from the Phase 7 spec section 4.

describe("apps-script-smart wire", () => {
  it("registers exactly 17 tools", () => {
    expect(tools).toHaveLength(17);
  });

  it("all tool names are snake_case", () => {
    const re = /^[a-z][a-z0-9_]*$/;
    for (const t of tools) {
      expect(t.name, `${t.name} should be snake_case`).toMatch(re);
    }
  });

  it("all tool names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("matches the spec's 17 tool names exactly", () => {
    const expected = [
      // projects (2)
      "create_project",
      "get_project",
      // content (3)
      "get_content",
      "update_content",
      "push_file",
      // metrics (1)
      "get_metrics",
      // versions (3)
      "create_version",
      "list_versions",
      "get_version",
      // deployments (5)
      "create_deployment",
      "list_deployments",
      "get_deployment",
      "update_deployment",
      "delete_deployment",
      // processes (1)
      "list_processes",
      // composites (2)
      "deploy_script",
      "run_function",
    ].sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });

  it("every tool description is <= 15 tokens (rough word count)", () => {
    for (const t of tools) {
      const wordCount = t.description.trim().split(/\s+/).length;
      expect(
        wordCount,
        `${t.name}: "${t.description}" exceeds budget`,
      ).toBeLessThanOrEqual(15);
    }
  });

  it("every tool description is non-empty", () => {
    for (const t of tools) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(0);
    }
  });
});
