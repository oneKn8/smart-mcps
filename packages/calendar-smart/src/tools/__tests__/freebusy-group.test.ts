import { describe, it, expect, vi } from "vitest";
import { freebusyGroupTool } from "../freebusy-group.js";

type FakeClient = {
  freeBusyGroup: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    freeBusyGroup: vi.fn(),
    ...over,
  };
}

describe("freebusyGroupTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(freebusyGroupTool.name).toBe("freebusy_group");
    expect(freebusyGroupTool.description).toBe(
      "Query group calendar availability",
    );
    expect(
      freebusyGroupTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("requires group_email, time_min, time_max", () => {
    expect(() => freebusyGroupTool.inputSchema.parse({})).toThrow();
    expect(() =>
      freebusyGroupTool.inputSchema.parse({ group_email: "x" }),
    ).toThrow();
  });

  it("expansion-max defaults are 100 and 50", () => {
    const parsed = freebusyGroupTool.inputSchema.parse({
      group_email: "team@example.test",
      time_min: "2026-05-13T00:00:00Z",
      time_max: "2026-05-14T00:00:00Z",
    }) as { group_expansion_max: number; calendar_expansion_max: number };
    expect(parsed.group_expansion_max).toBe(100);
    expect(parsed.calendar_expansion_max).toBe(50);
  });
});

describe("freebusyGroupTool — handler", () => {
  it("forwards group_email, time window, and expansion params to the client", async () => {
    const client = makeClient({
      freeBusyGroup: vi.fn().mockResolvedValue({ calendars: {} }),
    });
    const parsed = freebusyGroupTool.inputSchema.parse({
      group_email: "team@example.test",
      time_min: "2026-05-13T00:00:00Z",
      time_max: "2026-05-14T00:00:00Z",
      group_expansion_max: 25,
      calendar_expansion_max: 10,
    }) as Parameters<typeof freebusyGroupTool.handler>[0];

    await freebusyGroupTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.freeBusyGroup).toHaveBeenCalledWith({
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      groupEmail: "team@example.test",
      groupExpansionMax: 25,
      calendarExpansionMax: 10,
    });
  });

  it("surfaces per-member busy windows for successful members", async () => {
    const client = makeClient({
      freeBusyGroup: vi.fn().mockResolvedValue({
        calendars: {
          "alice@example.test": {
            busy: [
              { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
              { start: "2026-05-13T18:00:00Z", end: "2026-05-13T19:00:00Z" },
            ],
          },
          "bob@example.test": {
            busy: [],
          },
        },
      }),
    });
    const parsed = freebusyGroupTool.inputSchema.parse({
      group_email: "team@example.test",
      time_min: "2026-05-13T00:00:00Z",
      time_max: "2026-05-14T00:00:00Z",
    }) as Parameters<typeof freebusyGroupTool.handler>[0];

    const out = await freebusyGroupTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(out.members).toHaveLength(2);
    const alice = out.members.find((m) => m.email === "alice@example.test");
    expect(alice?.busy).toEqual([
      { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
      { start: "2026-05-13T18:00:00Z", end: "2026-05-13T19:00:00Z" },
    ]);
    expect(alice?.errors).toEqual([]);
    const bob = out.members.find((m) => m.email === "bob@example.test");
    expect(bob?.busy).toEqual([]);
  });

  it("surfaces per-member errors without failing the whole call", async () => {
    const client = makeClient({
      freeBusyGroup: vi.fn().mockResolvedValue({
        calendars: {
          "alice@example.test": {
            busy: [
              { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
            ],
          },
          "ghost@example.test": {
            busy: [],
            errors: [{ domain: "global", reason: "notFound" }],
          },
          "ratelimited@example.test": {
            busy: [],
            errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }],
          },
        },
      }),
    });
    const parsed = freebusyGroupTool.inputSchema.parse({
      group_email: "team@example.test",
      time_min: "2026-05-13T00:00:00Z",
      time_max: "2026-05-14T00:00:00Z",
    }) as Parameters<typeof freebusyGroupTool.handler>[0];

    const out = await freebusyGroupTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(out.members).toHaveLength(3);
    const ghost = out.members.find((m) => m.email === "ghost@example.test");
    expect(ghost?.errors).toEqual([{ domain: "global", reason: "notFound" }]);
    const limited = out.members.find(
      (m) => m.email === "ratelimited@example.test",
    );
    expect(limited?.errors).toEqual([
      { domain: "usageLimits", reason: "rateLimitExceeded" },
    ]);
    // Successful member still surfaces unaffected.
    const alice = out.members.find((m) => m.email === "alice@example.test");
    expect(alice?.busy).toHaveLength(1);
    expect(alice?.errors).toEqual([]);
  });

  it("returns an empty members array when the group has no resolved calendars", async () => {
    const client = makeClient({
      freeBusyGroup: vi.fn().mockResolvedValue({ calendars: {} }),
    });
    const parsed = freebusyGroupTool.inputSchema.parse({
      group_email: "empty@example.test",
      time_min: "2026-05-13T00:00:00Z",
      time_max: "2026-05-14T00:00:00Z",
    }) as Parameters<typeof freebusyGroupTool.handler>[0];

    const out = await freebusyGroupTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(out.members).toEqual([]);
  });

  it("drops malformed busy entries (missing start/end) defensively", async () => {
    const client = makeClient({
      freeBusyGroup: vi.fn().mockResolvedValue({
        calendars: {
          "alice@example.test": {
            busy: [
              { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
              { start: "2026-05-13T18:00:00Z" }, // missing end
              "not-an-object",
            ],
          },
        },
      }),
    });
    const parsed = freebusyGroupTool.inputSchema.parse({
      group_email: "team@example.test",
      time_min: "2026-05-13T00:00:00Z",
      time_max: "2026-05-14T00:00:00Z",
    }) as Parameters<typeof freebusyGroupTool.handler>[0];

    const out = await freebusyGroupTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(out.members[0]?.busy).toEqual([
      { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
    ]);
  });
});
