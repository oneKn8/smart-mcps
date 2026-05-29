import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

describe("slack-smart tool wiring", () => {
  it("exports the expected number of tools", () => {
    expect(tools).toHaveLength(0);
  });

  it("all names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all names are snake_case", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("all descriptions are non-empty and <= 120 chars", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.description.length).toBeLessThanOrEqual(120);
    }
  });

  it("all descriptions are unique", () => {
    const descs = tools.map((t) => t.description);
    expect(new Set(descs).size).toBe(descs.length);
  });
});
