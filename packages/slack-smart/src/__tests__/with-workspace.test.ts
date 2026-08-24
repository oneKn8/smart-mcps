import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, runToolSafely, zodToJsonSchema } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { withWorkspace } from "../with-workspace.js";
import { discoverWorkspaces, WorkspaceRegistry } from "../workspaces.js";

type FakeClient = { token: string };

function makeRegistry() {
  return new WorkspaceRegistry(
    discoverWorkspaces({
      SLACK_USER_TOKEN_TBC: "xoxp-tbc",
      SLACK_USER_TOKEN_VLLM: "xoxp-vllm",
      SLACK_DEFAULT_WORKSPACE: "tbc",
    }),
    entry => ({ token: entry.userToken }) as unknown as never,
  );
}

const echo = defineTool<{ channel: string }, { channel: string; token: string }, SlackContext>({
  name: "echo",
  description: "echo the client token",
  inputSchema: z.object({ channel: z.string() }),
  handler: async (input, context) => ({
    channel: input.channel,
    token: (context.client as unknown as FakeClient).token,
  }),
});

function baseContext(registry: WorkspaceRegistry): SlackContext {
  return { client: registry.clientFor(undefined), workspaces: registry };
}

async function call(registry: WorkspaceRegistry, args: unknown) {
  const wrapped = withWorkspace(echo, registry);
  const result = await runToolSafely(wrapped, args, baseContext(registry));
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  return { result, body: result.isError || !text ? undefined : JSON.parse(text) };
}

describe("withWorkspace", () => {
  it("routes to the default workspace when none is given", async () => {
    const { body } = await call(makeRegistry(), { channel: "C1" });
    expect(body).toEqual({ channel: "C1", token: "xoxp-tbc" });
  });

  it("routes to the named workspace and strips the field before the tool sees it", async () => {
    const { body } = await call(makeRegistry(), { channel: "C1", workspace: "vllm" });
    expect(body).toEqual({ channel: "C1", token: "xoxp-vllm" });
  });

  it("rejects an unknown workspace without calling the tool", async () => {
    const { result } = await call(makeRegistry(), { channel: "C1", workspace: "nope" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/configured: tbc, vllm/);
  });

  it("still validates the tool's own inputs", async () => {
    const { result } = await call(makeRegistry(), { workspace: "vllm" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/channel/);
  });

  it("advertises the workspace field in the tool's JSON schema", () => {
    const wrapped = withWorkspace(echo, makeRegistry());
    const json = zodToJsonSchema(wrapped.inputSchema) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(json.properties).sort()).toEqual(["channel", "workspace"]);
    expect(json.required ?? []).not.toContain("workspace");
  });

  it("refuses tools whose schema is not an object", () => {
    const odd = defineTool<string, string, SlackContext>({
      name: "odd",
      description: "",
      inputSchema: z.string(),
      handler: async s => s,
    });
    expect(() => withWorkspace(odd as never, makeRegistry())).toThrow(/z\.object/);
  });

  it("refuses tools that already declare a workspace input", () => {
    const clash = defineTool<{ workspace: string }, string, SlackContext>({
      name: "clash",
      description: "",
      inputSchema: z.object({ workspace: z.string() }),
      handler: async s => s.workspace,
    });
    expect(() => withWorkspace(clash, makeRegistry())).toThrow(/already declares/);
  });
});
