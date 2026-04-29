import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

describe("tools registry", () => {
  it("registers exactly 14 tools", () => {
    expect(tools.length).toBe(14);
  });

  it("all names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all names are snake_case (lowercase + underscores)", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("all descriptions are <=15 tokens (whitespace-separated)", () => {
    for (const t of tools) {
      const tokens = t.description.split(/\s+/).filter(Boolean);
      expect(
        tokens.length,
        `tool "${t.name}" has ${tokens.length} tokens: "${t.description}"`,
      ).toBeLessThanOrEqual(15);
    }
  });
});
