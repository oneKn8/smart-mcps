import { describe, it, expect } from "vitest";
import { mapUser } from "../user-mapper.js";

// ---------------------------------------------------------------------------
// full user
// ---------------------------------------------------------------------------

describe("mapUser — full user", () => {
  const raw = {
    id: "U001",
    name: "alice",
    is_bot: false,
    deleted: false,
    real_name: "Alice Smith",
    tz: "America/New_York",
    profile: {
      display_name: "alice_s",
      email: "alice@example.com",
      title: "Engineer",
    },
    extra_field: "drop_me",
  };

  it("maps required fields", () => {
    const slim = mapUser(raw);
    expect(slim.id).toBe("U001");
    expect(slim.name).toBe("alice");
    expect(slim.is_bot).toBe(false);
    expect(slim.deleted).toBe(false);
  });

  it("maps optional fields when present", () => {
    const slim = mapUser(raw);
    expect(slim.real_name).toBe("Alice Smith");
    expect(slim.display_name).toBe("alice_s");
    expect(slim.email).toBe("alice@example.com");
    expect(slim.tz).toBe("America/New_York");
  });

  it("strips extra upstream fields", () => {
    const slim = mapUser(raw) as Record<string, unknown>;
    expect(slim).not.toHaveProperty("extra_field");
    expect(slim).not.toHaveProperty("profile");
  });
});

// ---------------------------------------------------------------------------
// bot user
// ---------------------------------------------------------------------------

describe("mapUser — bot", () => {
  const raw = {
    id: "B001",
    name: "mybot",
    is_bot: true,
    deleted: false,
    profile: {},
  };

  it("sets is_bot=true", () => {
    const slim = mapUser(raw);
    expect(slim.is_bot).toBe(true);
  });

  it("omits optional fields absent from raw", () => {
    const slim = mapUser(raw);
    expect(slim).not.toHaveProperty("real_name");
    expect(slim).not.toHaveProperty("display_name");
    expect(slim).not.toHaveProperty("email");
    expect(slim).not.toHaveProperty("tz");
  });
});

// ---------------------------------------------------------------------------
// deleted user
// ---------------------------------------------------------------------------

describe("mapUser — deleted user", () => {
  const raw = {
    id: "U002",
    name: "bob",
    is_bot: false,
    deleted: true,
    profile: {},
  };

  it("sets deleted=true", () => {
    const slim = mapUser(raw);
    expect(slim.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// user missing profile fields
// ---------------------------------------------------------------------------

describe("mapUser — missing / empty profile fields", () => {
  it("omits display_name and email when profile is empty object", () => {
    const slim = mapUser({ id: "U003", name: "charlie", is_bot: false, deleted: false, profile: {} });
    expect(slim).not.toHaveProperty("display_name");
    expect(slim).not.toHaveProperty("email");
  });

  it("omits display_name when display_name is empty string", () => {
    const slim = mapUser({ id: "U004", name: "dave", is_bot: false, deleted: false, profile: { display_name: "" } });
    expect(slim).not.toHaveProperty("display_name");
  });

  it("falls back to empty id and name, false booleans when all absent", () => {
    const slim = mapUser({});
    expect(slim.id).toBe("");
    expect(slim.name).toBe("");
    expect(slim.is_bot).toBe(false);
    expect(slim.deleted).toBe(false);
  });

  it("does not throw when profile is absent (no profile key at all)", () => {
    expect(() => mapUser({ id: "U005", name: "eve" })).not.toThrow();
  });

  it("does not throw on non-object input", () => {
    expect(() => mapUser(null)).not.toThrow();
    expect(() => mapUser("bad")).not.toThrow();
    expect(() => mapUser(42)).not.toThrow();
  });
});
