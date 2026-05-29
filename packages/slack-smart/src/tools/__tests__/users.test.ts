import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { AmbiguousMatchError } from "smart-mcp-core";
import {
  list_users,
  user_info,
  user_profile,
  lookup_by_email,
  user_presence,
  resolve_user,
} from "../users.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  listUsers: ReturnType<typeof vi.fn>;
  getUserInfo: ReturnType<typeof vi.fn>;
  getUserProfile: ReturnType<typeof vi.fn>;
  lookupByEmail: ReturnType<typeof vi.fn>;
  getPresence: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    listUsers: vi.fn(),
    getUserInfo: vi.fn(),
    getUserProfile: vi.fn(),
    lookupByEmail: vi.fn(),
    getPresence: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

const fullUserRaw = {
  id: "U001",
  name: "alice",
  is_bot: false,
  deleted: false,
  real_name: "Alice Smith",
  tz: "America/New_York",
  profile: {
    display_name: "alice_s",
    email: "alice@example.com",
  },
  extra_field: "drop_me",
};

const botUserRaw = {
  id: "B001",
  name: "mybot",
  is_bot: true,
  deleted: false,
  profile: {},
};

// ---------------------------------------------------------------------------
// list_users
// ---------------------------------------------------------------------------

describe("list_users — metadata", () => {
  it("has correct name and description", () => {
    expect(list_users.name).toBe("list_users");
    expect(list_users.description.length).toBeGreaterThan(0);
    expect(list_users.description.length).toBeLessThanOrEqual(120);
  });

  it("inputSchema is a ZodType instance", () => {
    expect(list_users.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults limit to 100", () => {
    const parsed = list_users.inputSchema.parse({}) as { limit: number };
    expect(parsed.limit).toBe(100);
  });
});

describe("list_users — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("calls listUsers with default limit and maps members to slim shape", async () => {
    client.listUsers.mockResolvedValue({
      ok: true,
      members: [{ ...fullUserRaw }, botUserRaw],
      response_metadata: { next_cursor: "" },
    });
    const parsed = list_users.inputSchema.parse({}) as Parameters<typeof list_users.handler>[0];
    const result = (await list_users.handler(parsed, ctx(client))) as {
      users: Record<string, unknown>[];
      count: number;
    };
    expect(client.listUsers).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    expect(result.count).toBe(2);
    expect(result.users[0]?.id).toBe("U001");
    expect(result.users[0]?.display_name).toBe("alice_s");
    expect(result.users[0]).not.toHaveProperty("extra_field");
    expect(result.users[0]).not.toHaveProperty("profile");
  });

  it("surfaces next_cursor only when non-empty", async () => {
    client.listUsers.mockResolvedValueOnce({
      ok: true,
      members: [],
      response_metadata: { next_cursor: "page2" },
    });
    const parsed = list_users.inputSchema.parse({}) as Parameters<typeof list_users.handler>[0];
    const withCursor = (await list_users.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(withCursor).toHaveProperty("next_cursor", "page2");

    client.listUsers.mockResolvedValueOnce({
      ok: true,
      members: [],
      response_metadata: { next_cursor: "" },
    });
    const withoutCursor = (await list_users.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(withoutCursor).not.toHaveProperty("next_cursor");
  });
});

// ---------------------------------------------------------------------------
// user_info
// ---------------------------------------------------------------------------

describe("user_info — metadata", () => {
  it("has correct name", () => {
    expect(user_info.name).toBe("user_info");
  });
});

describe("user_info — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("calls getUserInfo with user id and returns slim user", async () => {
    client.getUserInfo.mockResolvedValue({ ok: true, user: fullUserRaw });
    const parsed = user_info.inputSchema.parse({ user: "U001" }) as Parameters<
      typeof user_info.handler
    >[0];
    const result = (await user_info.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(client.getUserInfo).toHaveBeenCalledWith({ user: "U001" });
    expect(result.id).toBe("U001");
    expect(result.email).toBe("alice@example.com");
    expect(result).not.toHaveProperty("profile");
  });
});

// ---------------------------------------------------------------------------
// user_profile
// ---------------------------------------------------------------------------

describe("user_profile — metadata", () => {
  it("has correct name", () => {
    expect(user_profile.name).toBe("user_profile");
  });
});

describe("user_profile — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("maps profile fields and strips extras", async () => {
    client.getUserProfile.mockResolvedValue({
      ok: true,
      profile: {
        display_name: "alice_s",
        real_name: "Alice Smith",
        email: "alice@example.com",
        title: "Engineer",
        phone: "555-1234",
        status_text: "In a meeting",
        status_emoji: ":calendar:",
        extra_key: "drop_me",
      },
    });
    const parsed = user_profile.inputSchema.parse({ user: "U001" }) as Parameters<
      typeof user_profile.handler
    >[0];
    const result = (await user_profile.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result.display_name).toBe("alice_s");
    expect(result.real_name).toBe("Alice Smith");
    expect(result.email).toBe("alice@example.com");
    expect(result.title).toBe("Engineer");
    expect(result.phone).toBe("555-1234");
    expect(result.status_text).toBe("In a meeting");
    expect(result.status_emoji).toBe(":calendar:");
    expect(result).not.toHaveProperty("extra_key");
  });

  it("omits keys with empty string values", async () => {
    client.getUserProfile.mockResolvedValue({
      ok: true,
      profile: {
        display_name: "",
        real_name: "",
        email: "",
        title: "",
        phone: "",
        status_text: "",
        status_emoji: "",
      },
    });
    const parsed = user_profile.inputSchema.parse({}) as Parameters<
      typeof user_profile.handler
    >[0];
    const result = (await user_profile.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("calls getUserProfile without user arg when user is omitted", async () => {
    client.getUserProfile.mockResolvedValue({ ok: true, profile: {} });
    const parsed = user_profile.inputSchema.parse({}) as Parameters<
      typeof user_profile.handler
    >[0];
    await user_profile.handler(parsed, ctx(client));
    expect(client.getUserProfile).toHaveBeenCalledWith({});
  });
});

// ---------------------------------------------------------------------------
// lookup_by_email
// ---------------------------------------------------------------------------

describe("lookup_by_email — metadata", () => {
  it("has correct name", () => {
    expect(lookup_by_email.name).toBe("lookup_by_email");
  });
});

describe("lookup_by_email — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("calls lookupByEmail with email and returns slim user", async () => {
    client.lookupByEmail.mockResolvedValue({ ok: true, user: fullUserRaw });
    const parsed = lookup_by_email.inputSchema.parse({
      email: "alice@example.com",
    }) as Parameters<typeof lookup_by_email.handler>[0];
    const result = (await lookup_by_email.handler(parsed, ctx(client))) as Record<
      string,
      unknown
    >;
    expect(client.lookupByEmail).toHaveBeenCalledWith({ email: "alice@example.com" });
    expect(result.id).toBe("U001");
    expect(result).not.toHaveProperty("profile");
  });
});

// ---------------------------------------------------------------------------
// user_presence
// ---------------------------------------------------------------------------

describe("user_presence — metadata", () => {
  it("has correct name", () => {
    expect(user_presence.name).toBe("user_presence");
  });
});

describe("user_presence — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns presence string", async () => {
    client.getPresence.mockResolvedValue({ ok: true, presence: "active" });
    const parsed = user_presence.inputSchema.parse({ user: "U001" }) as Parameters<
      typeof user_presence.handler
    >[0];
    const result = (await user_presence.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result.presence).toBe("active");
  });

  it("includes online when present in response", async () => {
    client.getPresence.mockResolvedValue({ ok: true, presence: "active", online: true });
    const parsed = user_presence.inputSchema.parse({}) as Parameters<
      typeof user_presence.handler
    >[0];
    const result = (await user_presence.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result.online).toBe(true);
  });

  it("omits online when absent from response", async () => {
    client.getPresence.mockResolvedValue({ ok: true, presence: "away" });
    const parsed = user_presence.inputSchema.parse({}) as Parameters<
      typeof user_presence.handler
    >[0];
    const result = (await user_presence.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result).not.toHaveProperty("online");
  });
});

// ---------------------------------------------------------------------------
// resolve_user
// ---------------------------------------------------------------------------

describe("resolve_user — metadata", () => {
  it("has correct name", () => {
    expect(resolve_user.name).toBe("resolve_user");
  });
});

describe("resolve_user — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns matched user when query closely matches display_name", async () => {
    client.listUsers.mockResolvedValue({
      ok: true,
      members: [
        { id: "U001", name: "alice", is_bot: false, deleted: false, profile: { display_name: "alice" } },
        { id: "U002", name: "bob", is_bot: false, deleted: false, profile: { display_name: "bob" } },
      ],
      response_metadata: { next_cursor: "" },
    });
    const parsed = resolve_user.inputSchema.parse({ query: "alice" }) as Parameters<
      typeof resolve_user.handler
    >[0];
    const result = (await resolve_user.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result.id).toBe("U001");
  });

  it("falls back to real_name when display_name is absent", async () => {
    client.listUsers.mockResolvedValue({
      ok: true,
      members: [
        { id: "U003", name: "charlie", is_bot: false, deleted: false, real_name: "Charlie Brown", profile: {} },
      ],
      response_metadata: { next_cursor: "" },
    });
    const parsed = resolve_user.inputSchema.parse({ query: "Charlie Brown" }) as Parameters<
      typeof resolve_user.handler
    >[0];
    const result = (await resolve_user.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result.id).toBe("U003");
  });

  it("propagates AmbiguousMatchError when query does not confidently match any user", async () => {
    // Two users with completely different names from the query "xyz" — both will score well below 0.9
    client.listUsers.mockResolvedValue({
      ok: true,
      members: [
        { id: "U010", name: "foo", is_bot: false, deleted: false, profile: { display_name: "foo" } },
        { id: "U011", name: "bar", is_bot: false, deleted: false, profile: { display_name: "bar" } },
      ],
      response_metadata: { next_cursor: "" },
    });
    const parsed = resolve_user.inputSchema.parse({ query: "xyz_nobody_1234" }) as Parameters<
      typeof resolve_user.handler
    >[0];
    await expect(resolve_user.handler(parsed, ctx(client))).rejects.toBeInstanceOf(
      AmbiguousMatchError,
    );
  });

  it("calls listUsers with limit 200", async () => {
    client.listUsers.mockResolvedValue({
      ok: true,
      members: [
        { id: "U001", name: "alice", is_bot: false, deleted: false, profile: { display_name: "alice" } },
      ],
      response_metadata: { next_cursor: "" },
    });
    const parsed = resolve_user.inputSchema.parse({ query: "alice" }) as Parameters<
      typeof resolve_user.handler
    >[0];
    await resolve_user.handler(parsed, ctx(client));
    expect(client.listUsers).toHaveBeenCalledWith({ limit: 200 });
  });
});
