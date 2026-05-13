import { describe, it, expect } from "vitest";
import { mapAclRule, type SlimAclRule } from "../acl-mapper.js";

const SLIM_KEYS: ReadonlyArray<keyof SlimAclRule> = [
  "id",
  "role",
  "scope_type",
  "scope_value",
];

function fixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "user:alice@example.test",
    role: "reader",
    scope: { type: "user", value: "alice@example.test" },
    ...over,
  };
}

describe("mapAclRule — basics", () => {
  it("maps a typical user-scoped rule", () => {
    const slim = mapAclRule(fixture());
    expect(slim).toEqual({
      id: "user:alice@example.test",
      role: "reader",
      scope_type: "user",
      scope_value: "alice@example.test",
    });
  });

  it("flattens nested scope.{type,value} into top-level fields", () => {
    const slim = mapAclRule(
      fixture({ scope: { type: "group", value: "team@example.test" } }),
    );
    expect(slim.scope_type).toBe("group");
    expect(slim.scope_value).toBe("team@example.test");
  });

  it("missing id degrades to empty string", () => {
    const fx = fixture();
    delete (fx as { id?: unknown }).id;
    const slim = mapAclRule(fx);
    expect(slim.id).toBe("");
  });
});

describe("mapAclRule — roles", () => {
  it.each([["none"], ["freeBusyReader"], ["reader"], ["writer"], ["owner"]])(
    "preserves role=%s",
    (role) => {
      const slim = mapAclRule(fixture({ role }));
      expect(slim.role).toBe(role);
    },
  );

  it("falls back to 'none' for an unknown role", () => {
    const slim = mapAclRule(fixture({ role: "superuser" }));
    expect(slim.role).toBe("none");
  });

  it("falls back to 'none' when role is missing", () => {
    const fx = fixture();
    delete (fx as { role?: unknown }).role;
    const slim = mapAclRule(fx);
    expect(slim.role).toBe("none");
  });
});

describe("mapAclRule — scope types", () => {
  it.each([["user"], ["group"], ["domain"]])(
    "preserves scope_type=%s with its value",
    (type) => {
      const slim = mapAclRule(
        fixture({ scope: { type, value: "principal@example.test" } }),
      );
      expect(slim.scope_type).toBe(type);
      expect(slim.scope_value).toBe("principal@example.test");
    },
  );

  it("scope_type=default with no value reads as scope_value=null", () => {
    const slim = mapAclRule(
      fixture({ id: "default", role: "reader", scope: { type: "default" } }),
    );
    expect(slim.scope_type).toBe("default");
    expect(slim.scope_value).toBeNull();
  });

  it("falls back to 'default' for an unknown scope type", () => {
    const slim = mapAclRule(fixture({ scope: { type: "alien" } }));
    expect(slim.scope_type).toBe("default");
  });

  it("missing scope block defaults to type=default, value=null", () => {
    const fx = fixture();
    delete (fx as { scope?: unknown }).scope;
    const slim = mapAclRule(fx);
    expect(slim.scope_type).toBe("default");
    expect(slim.scope_value).toBeNull();
  });

  it("non-string scope.value degrades to null", () => {
    const slim = mapAclRule(
      fixture({ scope: { type: "user", value: 12345 } }),
    );
    expect(slim.scope_value).toBeNull();
  });
});

describe("mapAclRule — domain scope", () => {
  it("maps a domain-scoped rule", () => {
    const slim = mapAclRule({
      id: "domain:example.test",
      role: "reader",
      scope: { type: "domain", value: "example.test" },
    });
    expect(slim).toEqual({
      id: "domain:example.test",
      role: "reader",
      scope_type: "domain",
      scope_value: "example.test",
    });
  });
});

describe("mapAclRule — error handling", () => {
  it("throws when given a non-object", () => {
    expect(() => mapAclRule(null)).toThrow();
    expect(() => mapAclRule(42)).toThrow();
    expect(() => mapAclRule([])).toThrow();
  });
});

describe("mapAclRule — field stripping", () => {
  it("returns exactly the 4 SlimAclRule keys (no upstream noise)", () => {
    const slim = mapAclRule({
      // Upstream noise that must NOT appear on the slim shape.
      kind: "calendar#aclRule",
      etag: "etag-abc",
      id: "user:alice@example.test",
      role: "writer",
      scope: { type: "user", value: "alice@example.test" },
    });
    expect(Object.keys(slim).sort()).toEqual([...SLIM_KEYS].sort());
  });
});
