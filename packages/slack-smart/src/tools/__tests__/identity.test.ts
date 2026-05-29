import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { whoami } from "../identity.js";

type FakeClient = {
  authTest: ReturnType<typeof vi.fn>;
};

function makeClient(
  response: Record<string, unknown>,
): FakeClient {
  return {
    authTest: vi.fn().mockResolvedValue(response),
  };
}

const baseResponse = {
  ok: true as const,
  url: "https://workspace.slack.com/",
  team: "Acme Corp",
  user: "alice",
  team_id: "T0123456789",
  user_id: "U0123456789",
};

describe("whoami — metadata", () => {
  it("has correct name and description", () => {
    expect(whoami.name).toBe("whoami");
    expect(whoami.description).toBe(
      "Show the authenticated Slack user and workspace.",
    );
  });

  it("input schema is a ZodType instance", () => {
    expect(whoami.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("token defaults to 'user' when omitted", () => {
    const parsed = whoami.inputSchema.parse({}) as { token: string };
    expect(parsed.token).toBe("user");
  });

  it("token accepts 'user' explicitly", () => {
    const parsed = whoami.inputSchema.parse({ token: "user" }) as {
      token: string;
    };
    expect(parsed.token).toBe("user");
  });

  it("token accepts 'bot' explicitly", () => {
    const parsed = whoami.inputSchema.parse({ token: "bot" }) as {
      token: string;
    };
    expect(parsed.token).toBe("bot");
  });

  it("token rejects unknown values", () => {
    expect(() => whoami.inputSchema.parse({ token: "admin" })).toThrow();
  });
});

describe("whoami — handler", () => {
  it("calls authTest with 'user' when token is 'user'", async () => {
    const client = makeClient(baseResponse);
    await whoami.handler(
      { token: "user" },
      { client: client as unknown as never },
    );
    expect(client.authTest).toHaveBeenCalledWith("user");
  });

  it("calls authTest with 'bot' when token is 'bot'", async () => {
    const client = makeClient({ ...baseResponse, bot_id: "B0123456789" });
    await whoami.handler(
      { token: "bot" },
      { client: client as unknown as never },
    );
    expect(client.authTest).toHaveBeenCalledWith("bot");
  });

  it("returns slim shape without bot_id when upstream omits it", async () => {
    const client = makeClient(baseResponse);
    const result = (await whoami.handler(
      { token: "user" },
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(result).toEqual({
      user_id: "U0123456789",
      user: "alice",
      team_id: "T0123456789",
      team: "Acme Corp",
      url: "https://workspace.slack.com/",
    });
    expect(result).not.toHaveProperty("bot_id");
    expect(result).not.toHaveProperty("ok");
  });

  it("returns slim shape with bot_id when upstream includes it", async () => {
    const client = makeClient({ ...baseResponse, bot_id: "B0123456789" });
    const result = (await whoami.handler(
      { token: "bot" },
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(result).toEqual({
      user_id: "U0123456789",
      user: "alice",
      team_id: "T0123456789",
      team: "Acme Corp",
      url: "https://workspace.slack.com/",
      bot_id: "B0123456789",
    });
  });

  it("strips extra upstream fields (ok, extra_field)", async () => {
    const client = makeClient({
      ...baseResponse,
      extra_field: "should_be_stripped",
    });
    const result = (await whoami.handler(
      { token: "user" },
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(result).not.toHaveProperty("ok");
    expect(result).not.toHaveProperty("extra_field");
    expect(Object.keys(result).sort()).toEqual(
      ["team", "team_id", "url", "user", "user_id"].sort(),
    );
  });

  it("default-resolution: parsing {} through schema yields token='user' and handler calls authTest('user')", async () => {
    const client = makeClient(baseResponse);
    const parsed = whoami.inputSchema.parse({}) as { token: "user" | "bot" };
    await whoami.handler(parsed, { client: client as unknown as never });
    expect(client.authTest).toHaveBeenCalledWith("user");
  });
});
