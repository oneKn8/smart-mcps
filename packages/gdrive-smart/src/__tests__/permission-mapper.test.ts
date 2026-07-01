import { describe, it, expect } from "vitest";
import { mapPermission, type SlimPermission } from "../permission-mapper.js";

const SLIM_KEYS: ReadonlyArray<keyof SlimPermission> = [
  "id",
  "type",
  "role",
  "email_address",
  "domain",
  "allow_file_discovery",
];

function fixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "perm_alpha",
    type: "user",
    role: "writer",
    emailAddress: "alice@example.test",
    ...over,
  };
}

describe("mapPermission — basics", () => {
  it("maps a typical user permission to the slim shape", () => {
    expect(mapPermission(fixture())).toEqual({
      id: "perm_alpha",
      type: "user",
      role: "writer",
      email_address: "alice@example.test",
      domain: null,
      allow_file_discovery: null,
    });
  });

  it("maps a domain permission (domain present, email null)", () => {
    const slim = mapPermission({
      id: "perm_domain",
      type: "domain",
      role: "reader",
      domain: "example.test",
      allowFileDiscovery: true,
    });
    expect(slim).toEqual({
      id: "perm_domain",
      type: "domain",
      role: "reader",
      email_address: null,
      domain: "example.test",
      allow_file_discovery: true,
    });
  });

  it("surfaces allowFileDiscovery for an anyone link (L3)", () => {
    expect(
      mapPermission({
        id: "anyoneWithLink",
        type: "anyone",
        role: "reader",
        allowFileDiscovery: false,
      }).allow_file_discovery,
    ).toBe(false);
    // Absent -> null (never leaks a fabricated boolean).
    expect(
      mapPermission({ id: "p", type: "user", role: "writer" })
        .allow_file_discovery,
    ).toBeNull();
  });

  it("maps an anyone (public link) permission with both principals null", () => {
    const slim = mapPermission({
      id: "anyoneWithLink",
      type: "anyone",
      role: "reader",
    });
    expect(slim.type).toBe("anyone");
    expect(slim.email_address).toBeNull();
    expect(slim.domain).toBeNull();
  });
});

describe("mapPermission — roles / types", () => {
  it.each([
    ["owner"],
    ["organizer"],
    ["fileOrganizer"],
    ["writer"],
    ["commenter"],
    ["reader"],
  ])("preserves role=%s", (role) => {
    expect(mapPermission(fixture({ role })).role).toBe(role);
  });

  it("falls back to 'reader' for an unknown role", () => {
    expect(mapPermission(fixture({ role: "superuser" })).role).toBe("reader");
  });

  it("falls back to 'reader' when role is missing", () => {
    const fx = fixture();
    delete (fx as Record<string, unknown>).role;
    expect(mapPermission(fx).role).toBe("reader");
  });

  it("falls back to 'user' (never widens to public) for an unknown type", () => {
    expect(mapPermission(fixture({ type: "alien" })).type).toBe("user");
  });
});

describe("mapPermission — error handling", () => {
  it("throws when given a non-object", () => {
    expect(() => mapPermission(null)).toThrow();
    expect(() => mapPermission(42)).toThrow();
    expect(() => mapPermission([])).toThrow();
  });
});

describe("mapPermission — field stripping", () => {
  it("returns exactly the 5 SlimPermission keys (no upstream noise)", () => {
    const slim = mapPermission({
      // Upstream noise that must NOT appear on the slim shape.
      kind: "drive#permission",
      etag: "etag-abc",
      displayName: "Alice",
      photoLink: "https://example.test/a.png",
      deleted: false,
      pendingOwner: false,
      id: "perm_alpha",
      type: "user",
      role: "writer",
      emailAddress: "alice@example.test",
    });
    expect(Object.keys(slim).sort()).toEqual([...SLIM_KEYS].sort());
  });
});
