import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { defineTool, runToolSafely, type ToolDefinition } from "../server.js";
import { AuthError, NotFoundError } from "../errors.js";

describe("defineTool", () => {
  it("returns a tool definition with name, description, schema, handler", () => {
    const tool = defineTool({
      name: "echo",
      description: "Echo input",
      inputSchema: z.object({ msg: z.string() }),
      handler: async ({ msg }) => ({ echoed: msg }),
    });
    expect(tool.name).toBe("echo");
    expect(tool.description).toBe("Echo input");
    expect(typeof tool.handler).toBe("function");
  });
});

describe("runToolSafely", () => {
  const echoTool = defineTool({
    name: "echo",
    description: "Echo input",
    inputSchema: z.object({ msg: z.string() }),
    handler: async ({ msg }) => ({ echoed: msg }),
  });

  it("returns success result with stringified JSON content", async () => {
    const result = await runToolSafely(echoTool, { msg: "hi" }, {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("echoed");
    expect(text).toContain("hi");
  });

  it("returns error result when input fails zod validation", async () => {
    const result = await runToolSafely(echoTool, { wrong: "x" }, {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("VALIDATION");
  });

  it("propagates SmartMcpError from handler", async () => {
    const tool = defineTool({
      name: "fail",
      description: "Always fails",
      inputSchema: z.object({}),
      handler: async () => {
        throw new AuthError("Bad token", { recovery: "Set token" });
      },
    });
    const result = await runToolSafely(tool, {}, {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("AUTH");
    expect(text).toContain("Bad token");
    expect(text).toContain("Set token");
  });

  it("wraps unknown errors as UPSTREAM", async () => {
    const tool = defineTool({
      name: "boom",
      description: "Throws unknown",
      inputSchema: z.object({}),
      handler: async () => {
        throw new Error("kaboom");
      },
    });
    const result = await runToolSafely(tool, {}, {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("UPSTREAM");
    expect(text).toContain("kaboom");
  });

  it("passes context to handler", async () => {
    const handler = vi.fn(async (input: { x: number }, ctx: { multiplier: number }) => ({
      result: input.x * ctx.multiplier,
    }));
    const tool = defineTool({
      name: "mul",
      description: "Multiply",
      inputSchema: z.object({ x: z.number() }),
      handler,
    });
    const result = await runToolSafely(tool, { x: 3 }, { multiplier: 5 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("15");
  });
});
