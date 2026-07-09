import { describe, expect, it } from "vitest";
import { tools } from "../tools/index.js";

describe("drive-smart tool wiring", () => {
  it("exports unique snake_case tools with descriptions", () => {
    expect(tools.length).toBe(7);
    const names = tools.map(tool => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^drive_[a-z0-9_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});
