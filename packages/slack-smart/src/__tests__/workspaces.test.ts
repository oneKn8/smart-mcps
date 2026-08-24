import { describe, it, expect } from "vitest";
import { AuthError, ValidationError } from "smart-mcp-core";
import {
  discoverWorkspaces,
  WorkspaceRegistry,
  type WorkspaceEntry,
} from "../workspaces.js";

type Env = Record<string, string | undefined>;

function registry(env: Env) {
  const made: WorkspaceEntry[] = [];
  const reg = new WorkspaceRegistry(discoverWorkspaces(env), entry => {
    made.push(entry);
    return { token: entry.userToken } as unknown as never;
  });
  return { reg, made };
}

describe("discoverWorkspaces", () => {
  it("reads one workspace per SLACK_USER_TOKEN_<NAME> and attaches its bot token", () => {
    const found = discoverWorkspaces({
      SLACK_USER_TOKEN_TBC: "xoxp-tbc",
      SLACK_BOT_TOKEN_TBC: "xoxb-tbc",
      SLACK_USER_TOKEN_VLLM: "xoxp-vllm",
      SLACK_DEFAULT_WORKSPACE: "tbc",
    });
    expect([...found.workspaces.keys()].sort()).toEqual(["tbc", "vllm"]);
    expect(found.workspaces.get("tbc")).toEqual({
      name: "tbc",
      userToken: "xoxp-tbc",
      botToken: "xoxb-tbc",
    });
    expect(found.workspaces.get("vllm")?.botToken).toBeUndefined();
  });

  it("keeps the legacy bare SLACK_USER_TOKEN as workspace 'default' when nothing is named", () => {
    const found = discoverWorkspaces({
      SLACK_USER_TOKEN: "xoxp-legacy",
      SLACK_BOT_TOKEN: "xoxb-legacy",
    });
    expect([...found.workspaces.keys()]).toEqual(["default"]);
    expect(found.defaultName).toBe("default");
    expect(found.workspaces.get("default")?.botToken).toBe("xoxb-legacy");
  });

  it("ignores the bare token once named workspaces exist", () => {
    const found = discoverWorkspaces({
      SLACK_USER_TOKEN: "xoxp-legacy",
      SLACK_USER_TOKEN_TBC: "xoxp-tbc",
    });
    expect([...found.workspaces.keys()]).toEqual(["tbc"]);
  });

  it("uses the only workspace as the default without SLACK_DEFAULT_WORKSPACE", () => {
    expect(discoverWorkspaces({ SLACK_USER_TOKEN_VLLM: "x" }).defaultName).toBe("vllm");
  });

  it("honours SLACK_DEFAULT_WORKSPACE case-insensitively", () => {
    const found = discoverWorkspaces({
      SLACK_USER_TOKEN_TBC: "a",
      SLACK_USER_TOKEN_VLLM: "b",
      SLACK_DEFAULT_WORKSPACE: "TBC",
    });
    expect(found.defaultName).toBe("tbc");
  });

  it("refuses several workspaces with no default named", () => {
    expect(() =>
      discoverWorkspaces({ SLACK_USER_TOKEN_TBC: "a", SLACK_USER_TOKEN_VLLM: "b" }),
    ).toThrow(AuthError);
  });

  it("refuses a default that is not configured", () => {
    expect(() =>
      discoverWorkspaces({ SLACK_USER_TOKEN_TBC: "a", SLACK_DEFAULT_WORKSPACE: "vllm" }),
    ).toThrow(/vllm/);
  });

  it("refuses a bot token with no user token for the same workspace", () => {
    expect(() => discoverWorkspaces({ SLACK_BOT_TOKEN_VLLM: "xoxb" })).toThrow(/VLLM/);
  });

  it("refuses an empty environment with a message naming both forms", () => {
    expect(() => discoverWorkspaces({})).toThrow(/SLACK_USER_TOKEN_<NAME>/);
  });

  it("ignores blank values", () => {
    const found = discoverWorkspaces({
      SLACK_USER_TOKEN_TBC: "a",
      SLACK_USER_TOKEN_VLLM: "",
      SLACK_BOT_TOKEN_TBC: "",
    });
    expect([...found.workspaces.keys()]).toEqual(["tbc"]);
    expect(found.workspaces.get("tbc")?.botToken).toBeUndefined();
  });
});

describe("WorkspaceRegistry", () => {
  const env: Env = {
    SLACK_USER_TOKEN_TBC: "xoxp-tbc",
    SLACK_USER_TOKEN_VLLM: "xoxp-vllm",
    SLACK_DEFAULT_WORKSPACE: "tbc",
  };

  it("lists names with the default first", () => {
    const { reg } = registry(env);
    expect(reg.names()).toEqual(["tbc", "vllm"]);
    expect(reg.defaultName).toBe("tbc");
  });

  it("resolves the default client when no workspace is given", () => {
    const { reg, made } = registry(env);
    const client = reg.clientFor(undefined) as unknown as { token: string };
    expect(client.token).toBe("xoxp-tbc");
    expect(made.map(m => m.name)).toEqual(["tbc"]);
  });

  it("resolves a named workspace case-insensitively and builds each client once", () => {
    const { reg, made } = registry(env);
    const a = reg.clientFor("VLLM");
    const b = reg.clientFor("vllm");
    expect(a).toBe(b);
    expect(made.map(m => m.name)).toEqual(["vllm"]);
  });

  it("rejects an unknown workspace and names the configured ones", () => {
    const { reg } = registry(env);
    expect(() => reg.clientFor("litellm")).toThrow(ValidationError);
    expect(() => reg.clientFor("litellm")).toThrow(/tbc, vllm/);
  });
});
