import { describe, it, expect, vi, beforeEach } from "vitest";
import { list_usergroups, team_info, list_emoji } from "../misc.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  listUsergroups: ReturnType<typeof vi.fn>;
  teamInfo: ReturnType<typeof vi.fn>;
  listEmoji: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    listUsergroups: vi.fn(),
    teamInfo: vi.fn(),
    listEmoji: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

function parse<T>(tool: { inputSchema: { parse: (v: unknown) => T } }, raw: unknown): T {
  return tool.inputSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// list_usergroups
// ---------------------------------------------------------------------------

describe("list_usergroups — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns slim usergroups with count", async () => {
    client.listUsergroups.mockResolvedValue({
      ok: true,
      usergroups: [
        { id: "UG001", name: "Engineers", handle: "eng", description: "eng team", user_count: 10 },
        { id: "UG002", name: "Design", handle: "design", user_count: 5 },
      ],
    });
    const input = parse(list_usergroups, {});
    const result = (await list_usergroups.handler(input, ctx(client))) as {
      usergroups: Array<Record<string, unknown>>;
      count: number;
    };
    expect(result.count).toBe(2);
    expect(result.usergroups[0]?.id).toBe("UG001");
    expect(result.usergroups[0]?.name).toBe("Engineers");
    expect(result.usergroups[0]?.handle).toBe("eng");
    expect(result.usergroups[0]?.description).toBe("eng team");
    expect(result.usergroups[0]?.user_count).toBe(10);
  });

  it("omits description when empty string", async () => {
    client.listUsergroups.mockResolvedValue({
      ok: true,
      usergroups: [{ id: "UG001", name: "Dev", handle: "dev", description: "" }],
    });
    const input = parse(list_usergroups, {});
    const result = (await list_usergroups.handler(input, ctx(client))) as {
      usergroups: Array<Record<string, unknown>>;
    };
    expect(result.usergroups[0]).not.toHaveProperty("description");
  });

  it("returns count 0 for empty array", async () => {
    client.listUsergroups.mockResolvedValue({ ok: true, usergroups: [] });
    const input = parse(list_usergroups, {});
    const result = (await list_usergroups.handler(input, ctx(client))) as {
      count: number;
    };
    expect(result.count).toBe(0);
  });

  it("passes include_disabled to client when provided", async () => {
    client.listUsergroups.mockResolvedValue({ ok: true, usergroups: [] });
    const input = parse(list_usergroups, { include_disabled: true });
    await list_usergroups.handler(input, ctx(client));
    const [args] = client.listUsergroups.mock.calls[0] as [Record<string, unknown>];
    expect(args.include_disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// team_info
// ---------------------------------------------------------------------------

describe("team_info — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns slim team fields", async () => {
    client.teamInfo.mockResolvedValue({
      ok: true,
      team: {
        id: "T001",
        name: "Acme Corp",
        domain: "acme",
        email_domain: "acme.com",
        icon: { image_88: "https://img.example.com/88.png", image_132: "https://img.example.com/132.png" },
      },
    });
    const input = parse(team_info, {});
    const result = (await team_info.handler(input, ctx(client))) as Record<string, unknown>;
    expect(result.id).toBe("T001");
    expect(result.name).toBe("Acme Corp");
    expect(result.domain).toBe("acme");
    expect(result.email_domain).toBe("acme.com");
    expect(result.icon).toBe("https://img.example.com/132.png");
  });

  it("omits optional fields when absent", async () => {
    client.teamInfo.mockResolvedValue({
      ok: true,
      team: { id: "T001", name: "Acme Corp" },
    });
    const input = parse(team_info, {});
    const result = (await team_info.handler(input, ctx(client))) as Record<string, unknown>;
    expect(result.id).toBe("T001");
    expect(result).not.toHaveProperty("domain");
    expect(result).not.toHaveProperty("email_domain");
    expect(result).not.toHaveProperty("icon");
  });
});

// ---------------------------------------------------------------------------
// list_emoji
// ---------------------------------------------------------------------------

describe("list_emoji — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns full emoji map and count equals key count", async () => {
    const emojiMap = {
      rocket: "https://example.com/rocket.png",
      wave: "https://example.com/wave.png",
      custom_star: "alias:star",
    };
    client.listEmoji.mockResolvedValue({ ok: true, emoji: emojiMap });
    const input = parse(list_emoji, {});
    const result = (await list_emoji.handler(input, ctx(client))) as {
      count: number;
      emoji: Record<string, string>;
    };
    expect(result.count).toBe(3);
    expect(result.count).toBe(Object.keys(result.emoji).length);
    expect(result.emoji["rocket"]).toBe("https://example.com/rocket.png");
    expect(result.emoji["custom_star"]).toBe("alias:star");
  });

  it("returns count 0 for empty emoji map", async () => {
    client.listEmoji.mockResolvedValue({ ok: true, emoji: {} });
    const input = parse(list_emoji, {});
    const result = (await list_emoji.handler(input, ctx(client))) as {
      count: number;
      emoji: Record<string, string>;
    };
    expect(result.count).toBe(0);
    expect(Object.keys(result.emoji)).toHaveLength(0);
  });

  it("count equals number of keys in emoji map (verified)", async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 10; i++) big[`emoji${i}`] = `https://example.com/${i}.png`;
    client.listEmoji.mockResolvedValue({ ok: true, emoji: big });
    const input = parse(list_emoji, {});
    const result = (await list_emoji.handler(input, ctx(client))) as {
      count: number;
      emoji: Record<string, string>;
    };
    expect(result.count).toBe(10);
    expect(result.count).toBe(Object.keys(result.emoji).length);
  });
});
