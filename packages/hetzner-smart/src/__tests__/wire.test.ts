import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

describe("hetzner-smart tool wiring", () => {
  it("exposes exactly 71 tools", () => {
    expect(tools).toHaveLength(71);
  });

  it("has a unique name for every tool", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses snake_case names", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("gives every tool a non-empty description", () => {
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("gives every tool an input schema and a handler", () => {
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
      expect(typeof t.handler).toBe("function");
    }
  });

  it("keeps tool descriptions short (<= 15 words)", () => {
    for (const t of tools) {
      expect(t.description.trim().split(/\s+/).length).toBeLessThanOrEqual(15);
    }
  });
});
