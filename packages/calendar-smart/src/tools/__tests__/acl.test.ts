import { describe, it, expect, vi } from "vitest";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  listCalendarSharesTool,
  shareCalendarTool,
} from "../acl.js";

type FakeClient = {
  listAcl: ReturnType<typeof vi.fn>;
  getAclRule: ReturnType<typeof vi.fn>;
  insertAclRule: ReturnType<typeof vi.fn>;
  updateAclRule: ReturnType<typeof vi.fn>;
  deleteAclRule: ReturnType<typeof vi.fn>;
  getCalendarListEntry: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    listAcl: vi.fn(),
    getAclRule: vi.fn(),
    insertAclRule: vi.fn(),
    updateAclRule: vi.fn(),
    deleteAclRule: vi.fn(),
    getCalendarListEntry: vi.fn(),
    ...over,
  };
}

const aliceRule: Record<string, unknown> = {
  id: "user:alice@example.test",
  role: "reader",
  scope: { type: "user", value: "alice@example.test" },
};

const defaultRule: Record<string, unknown> = {
  id: "default",
  role: "freeBusyReader",
  scope: { type: "default" },
};

const primaryEntry: Record<string, unknown> = {
  id: "primary",
  summary: "Personal",
  primary: true,
  accessRole: "owner",
  timeZone: "America/Chicago",
};

// =============================================================================
// list_calendar_shares
// =============================================================================

describe("listCalendarSharesTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(listCalendarSharesTool.name).toBe("list_calendar_shares");
    expect(listCalendarSharesTool.description).toBe(
      "List who can access a calendar",
    );
    expect(
      listCalendarSharesTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("calendar_id defaults to 'primary'", () => {
    const parsed = listCalendarSharesTool.inputSchema.parse({}) as {
      calendar_id: string;
    };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("listCalendarSharesTool — handler", () => {
  it("calls listAcl with the supplied calendar_id and maps rules", async () => {
    const client = makeClient({
      listAcl: vi.fn().mockResolvedValue([aliceRule, defaultRule]),
    });
    const parsed = listCalendarSharesTool.inputSchema.parse({
      calendar_id: "cal_work",
    }) as Parameters<typeof listCalendarSharesTool.handler>[0];

    const out = await listCalendarSharesTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listAcl).toHaveBeenCalledWith({ calendarId: "cal_work" });
    expect(out.shares).toHaveLength(2);
    expect(out.shares[0]).toEqual({
      id: "user:alice@example.test",
      role: "reader",
      scope_type: "user",
      scope_value: "alice@example.test",
    });
    expect(out.shares[1]).toEqual({
      id: "default",
      role: "freeBusyReader",
      scope_type: "default",
      scope_value: null,
    });
  });

  it("defaults to 'primary' when calendar_id is omitted", async () => {
    const client = makeClient({ listAcl: vi.fn().mockResolvedValue([]) });
    const parsed = listCalendarSharesTool.inputSchema.parse(
      {},
    ) as Parameters<typeof listCalendarSharesTool.handler>[0];

    await listCalendarSharesTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listAcl).toHaveBeenCalledWith({ calendarId: "primary" });
  });

  it("returns an empty shares array when there are no rules", async () => {
    const client = makeClient({ listAcl: vi.fn().mockResolvedValue([]) });
    const parsed = listCalendarSharesTool.inputSchema.parse(
      {},
    ) as Parameters<typeof listCalendarSharesTool.handler>[0];

    const out = await listCalendarSharesTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.shares).toEqual([]);
  });
});

// =============================================================================
// share_calendar
// =============================================================================

describe("shareCalendarTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(shareCalendarTool.name).toBe("share_calendar");
    expect(shareCalendarTool.description).toBe(
      "Share a calendar with someone",
    );
    expect(
      shareCalendarTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("requires role and scope_type", () => {
    expect(() => shareCalendarTool.inputSchema.parse({})).toThrow();
    expect(() =>
      shareCalendarTool.inputSchema.parse({ role: "reader" }),
    ).toThrow();
  });

  it("defaults send_notifications=true and confirm=false", () => {
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "reader",
      scope_type: "default",
    }) as { send_notifications: boolean; confirm: boolean };
    expect(parsed.send_notifications).toBe(true);
    expect(parsed.confirm).toBe(false);
  });
});

describe("shareCalendarTool — destructive guard + preview", () => {
  it("throws ConfirmRequiredError with descriptive preview when confirm is false", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(primaryEntry),
    });
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "writer",
      scope_type: "user",
      scope_value: "bob@example.test",
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    await expect(
      shareCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toMatchObject({
      name: "ConfirmRequiredError",
      preview: expect.stringContaining(
        "Grant writer access to user:bob@example.test on calendar 'Personal'",
      ),
    });
    expect(client.insertAclRule).not.toHaveBeenCalled();
  });

  it("preview falls back to the raw calendar id when CalendarList lookup fails", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockRejectedValue(new Error("nope")),
    });
    const parsed = shareCalendarTool.inputSchema.parse({
      calendar_id: "cal_unknown",
      role: "reader",
      scope_type: "user",
      scope_value: "ada@example.test",
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    await expect(
      shareCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
  });
});

describe("shareCalendarTool — handler (confirmed)", () => {
  it("user scope: POSTs body with role + scope.{type,value}; default sendNotifications=true", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(primaryEntry),
      insertAclRule: vi.fn().mockResolvedValue(aliceRule),
    });
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "reader",
      scope_type: "user",
      scope_value: "alice@example.test",
      confirm: true,
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    const out = await shareCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertAclRule).toHaveBeenCalledWith({
      calendarId: "primary",
      body: {
        role: "reader",
        scope: { type: "user", value: "alice@example.test" },
      },
      sendNotifications: true,
    });
    expect(out.share).toEqual({
      id: "user:alice@example.test",
      role: "reader",
      scope_type: "user",
      scope_value: "alice@example.test",
    });
  });

  it("default scope: omits scope.value entirely from the body", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(primaryEntry),
      insertAclRule: vi.fn().mockResolvedValue(defaultRule),
    });
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "freeBusyReader",
      scope_type: "default",
      confirm: true,
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    await shareCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertAclRule).toHaveBeenCalledWith({
      calendarId: "primary",
      body: {
        role: "freeBusyReader",
        scope: { type: "default" },
      },
      sendNotifications: true,
    });
  });

  it("forwards send_notifications=false to the client", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(primaryEntry),
      insertAclRule: vi.fn().mockResolvedValue(aliceRule),
    });
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "reader",
      scope_type: "user",
      scope_value: "alice@example.test",
      send_notifications: false,
      confirm: true,
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    await shareCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertAclRule).toHaveBeenCalledWith(
      expect.objectContaining({ sendNotifications: false }),
    );
  });

  it("group scope works with scope_value", async () => {
    const groupRule = {
      id: "group:team@example.test",
      role: "writer",
      scope: { type: "group", value: "team@example.test" },
    };
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(primaryEntry),
      insertAclRule: vi.fn().mockResolvedValue(groupRule),
    });
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "writer",
      scope_type: "group",
      scope_value: "team@example.test",
      confirm: true,
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    const out = await shareCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertAclRule).toHaveBeenCalledWith({
      calendarId: "primary",
      body: {
        role: "writer",
        scope: { type: "group", value: "team@example.test" },
      },
      sendNotifications: true,
    });
    expect(out.share.scope_type).toBe("group");
  });
});

describe("shareCalendarTool — scope-shape validation", () => {
  it("rejects scope_value when scope_type is 'default'", async () => {
    const client = makeClient();
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "reader",
      scope_type: "default",
      scope_value: "anyone@example.test",
      confirm: true,
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    await expect(
      shareCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.insertAclRule).not.toHaveBeenCalled();
  });

  it("requires scope_value when scope_type is 'user'", async () => {
    const client = makeClient();
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "reader",
      scope_type: "user",
      confirm: true,
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    await expect(
      shareCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires scope_value when scope_type is 'group'", async () => {
    const client = makeClient();
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "reader",
      scope_type: "group",
      confirm: true,
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    await expect(
      shareCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires scope_value when scope_type is 'domain'", async () => {
    const client = makeClient();
    const parsed = shareCalendarTool.inputSchema.parse({
      role: "reader",
      scope_type: "domain",
      confirm: true,
    }) as Parameters<typeof shareCalendarTool.handler>[0];

    await expect(
      shareCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
