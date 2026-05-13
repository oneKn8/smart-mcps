import { describe, it, expect, vi } from "vitest";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  createCalendarTool,
  updateCalendarTool,
  deleteCalendarTool,
  clearPrimaryCalendarTool,
} from "../calendars-write.js";

type FakeClient = {
  insertCalendar: ReturnType<typeof vi.fn>;
  patchCalendar: ReturnType<typeof vi.fn>;
  deleteCalendar: ReturnType<typeof vi.fn>;
  clearPrimaryCalendar: ReturnType<typeof vi.fn>;
  getCalendarListEntry: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    insertCalendar: vi.fn(),
    patchCalendar: vi.fn(),
    deleteCalendar: vi.fn(),
    clearPrimaryCalendar: vi.fn(),
    getCalendarListEntry: vi.fn(),
    ...over,
  };
}

const calNew: Record<string, unknown> = {
  id: "cal_new",
  summary: "Side Project",
  timeZone: "America/Chicago",
  description: "tracker",
};

const calNewListEntry: Record<string, unknown> = {
  id: "cal_new",
  summary: "Side Project",
  accessRole: "owner",
  timeZone: "America/Chicago",
  description: "tracker",
};

// ============================================================================
// create_calendar
// ============================================================================

describe("createCalendarTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(createCalendarTool.name).toBe("create_calendar");
    expect(createCalendarTool.description).toBe(
      "Create a new secondary calendar",
    );
    expect(
      createCalendarTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires summary", () => {
    expect(() => createCalendarTool.inputSchema.parse({})).toThrow();
    const parsed = createCalendarTool.inputSchema.parse({
      summary: "Side Project",
    }) as { summary: string };
    expect(parsed.summary).toBe("Side Project");
  });
});

describe("createCalendarTool — handler", () => {
  it("POSTs only the provided fields (camelCase) and re-fetches CalendarList entry", async () => {
    const client = makeClient({
      insertCalendar: vi.fn().mockResolvedValue(calNew),
      getCalendarListEntry: vi.fn().mockResolvedValue(calNewListEntry),
    });
    const parsed = createCalendarTool.inputSchema.parse({
      summary: "Side Project",
      description: "tracker",
      time_zone: "America/Chicago",
    }) as Parameters<typeof createCalendarTool.handler>[0];

    const out = await createCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertCalendar).toHaveBeenCalledWith({
      summary: "Side Project",
      description: "tracker",
      timeZone: "America/Chicago",
    });
    expect(client.getCalendarListEntry).toHaveBeenCalledWith("cal_new");
    expect(out.calendar.id).toBe("cal_new");
    expect(out.calendar.access_role).toBe("owner");
  });

  it("omits optional fields entirely from the body when not provided", async () => {
    const client = makeClient({
      insertCalendar: vi.fn().mockResolvedValue(calNew),
      getCalendarListEntry: vi.fn().mockResolvedValue(calNewListEntry),
    });
    const parsed = createCalendarTool.inputSchema.parse({
      summary: "Side Project",
    }) as Parameters<typeof createCalendarTool.handler>[0];

    await createCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertCalendar).toHaveBeenCalledWith({
      summary: "Side Project",
    });
  });

  it("falls back to the bare /calendars/{id} shape if CalendarList re-fetch fails", async () => {
    const client = makeClient({
      insertCalendar: vi.fn().mockResolvedValue(calNew),
      getCalendarListEntry: vi.fn().mockRejectedValue(new Error("transient")),
    });
    const parsed = createCalendarTool.inputSchema.parse({
      summary: "Side Project",
    }) as Parameters<typeof createCalendarTool.handler>[0];

    const out = await createCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.calendar.id).toBe("cal_new");
    // Without the CalendarList re-fetch, access_role defaults to "reader".
    expect(out.calendar.access_role).toBe("reader");
  });
});

// ============================================================================
// update_calendar
// ============================================================================

describe("updateCalendarTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(updateCalendarTool.name).toBe("update_calendar");
    expect(updateCalendarTool.description).toBe("Update calendar metadata");
    expect(
      updateCalendarTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires calendar_id", () => {
    expect(() => updateCalendarTool.inputSchema.parse({})).toThrow();
  });
});

describe("updateCalendarTool — handler", () => {
  it("PATCHes only the provided fields with snake_case-to-camelCase mapping", async () => {
    const client = makeClient({
      patchCalendar: vi.fn().mockResolvedValue(calNew),
      getCalendarListEntry: vi.fn().mockResolvedValue(calNewListEntry),
    });
    const parsed = updateCalendarTool.inputSchema.parse({
      calendar_id: "cal_new",
      summary: "Renamed",
      description: "fresh desc",
      time_zone: "America/Chicago",
    }) as Parameters<typeof updateCalendarTool.handler>[0];

    const out = await updateCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchCalendar).toHaveBeenCalledWith({
      calendarId: "cal_new",
      body: {
        summary: "Renamed",
        description: "fresh desc",
        timeZone: "America/Chicago",
      },
    });
    expect(client.getCalendarListEntry).toHaveBeenCalledWith("cal_new");
    expect(out.calendar.id).toBe("cal_new");
    expect(out.calendar.access_role).toBe("owner");
  });

  it("omits the body entirely when no fields are provided beyond calendar_id", async () => {
    const client = makeClient({
      patchCalendar: vi.fn().mockResolvedValue(calNew),
      getCalendarListEntry: vi.fn().mockResolvedValue(calNewListEntry),
    });
    const parsed = updateCalendarTool.inputSchema.parse({
      calendar_id: "cal_new",
    }) as Parameters<typeof updateCalendarTool.handler>[0];
    await updateCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.patchCalendar).toHaveBeenCalledWith({
      calendarId: "cal_new",
      body: {},
    });
  });
});

// ============================================================================
// delete_calendar (destructive — confirm-gated, primary guard)
// ============================================================================

describe("deleteCalendarTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(deleteCalendarTool.name).toBe("delete_calendar");
    expect(deleteCalendarTool.description).toBe(
      "Delete a secondary calendar permanently",
    );
    expect(
      deleteCalendarTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });
});

describe("deleteCalendarTool — handler", () => {
  it("throws ValidationError when calendar_id is the literal 'primary'", async () => {
    const client = makeClient();
    const parsed = deleteCalendarTool.inputSchema.parse({
      calendar_id: "primary",
      confirm: true,
    }) as Parameters<typeof deleteCalendarTool.handler>[0];
    await expect(
      deleteCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.deleteCalendar).not.toHaveBeenCalled();
  });

  it("throws ValidationError when calendar_id resolves to the primary calendar", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue({
        id: "alice@example.test",
        summary: "Personal",
        primary: true,
        accessRole: "owner",
        timeZone: "America/Chicago",
      }),
    });
    const parsed = deleteCalendarTool.inputSchema.parse({
      calendar_id: "alice@example.test",
      confirm: true,
    }) as Parameters<typeof deleteCalendarTool.handler>[0];
    await expect(
      deleteCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.deleteCalendar).not.toHaveBeenCalled();
  });

  it("throws ConfirmRequiredError when confirm is omitted", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(calNewListEntry),
    });
    const parsed = deleteCalendarTool.inputSchema.parse({
      calendar_id: "cal_new",
    }) as Parameters<typeof deleteCalendarTool.handler>[0];
    await expect(
      deleteCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteCalendar).not.toHaveBeenCalled();
  });

  it("preview includes the calendar summary and id", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(calNewListEntry),
    });
    const parsed = deleteCalendarTool.inputSchema.parse({
      calendar_id: "cal_new",
    }) as Parameters<typeof deleteCalendarTool.handler>[0];
    try {
      await deleteCalendarTool.handler(parsed, {
        client: client as unknown as never,
      });
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const e = err as ConfirmRequiredError;
      expect(e.preview).toContain("Side Project");
      expect(e.preview).toContain("cal_new");
    }
  });

  it("falls back to calendar_id verbatim when CalendarList lookup fails", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockRejectedValue(new Error("no access")),
    });
    const parsed = deleteCalendarTool.inputSchema.parse({
      calendar_id: "cal_new",
    }) as Parameters<typeof deleteCalendarTool.handler>[0];
    try {
      await deleteCalendarTool.handler(parsed, {
        client: client as unknown as never,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const e = err as ConfirmRequiredError;
      expect(e.preview).toContain("cal_new");
    }
  });

  it("calls client.deleteCalendar when confirmed and returns deleted: true", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(calNewListEntry),
      deleteCalendar: vi.fn().mockResolvedValue(undefined),
    });
    const parsed = deleteCalendarTool.inputSchema.parse({
      calendar_id: "cal_new",
      confirm: true,
    }) as Parameters<typeof deleteCalendarTool.handler>[0];
    const out = await deleteCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.deleteCalendar).toHaveBeenCalledWith({
      calendarId: "cal_new",
    });
    expect(out).toEqual({ deleted: true });
  });
});

// ============================================================================
// clear_primary_calendar (destructive, NUKE option)
// ============================================================================

describe("clearPrimaryCalendarTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(clearPrimaryCalendarTool.name).toBe("clear_primary_calendar");
    expect(clearPrimaryCalendarTool.description).toBe(
      "Wipe ALL events from primary calendar",
    );
    expect(
      clearPrimaryCalendarTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });
});

describe("clearPrimaryCalendarTool — handler", () => {
  it("throws ConfirmRequiredError when confirm is omitted", async () => {
    const client = makeClient();
    const parsed = clearPrimaryCalendarTool.inputSchema.parse(
      {},
    ) as Parameters<typeof clearPrimaryCalendarTool.handler>[0];
    await expect(
      clearPrimaryCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.clearPrimaryCalendar).not.toHaveBeenCalled();
  });

  it("preview mentions irreversibility and primary calendar", async () => {
    const client = makeClient();
    const parsed = clearPrimaryCalendarTool.inputSchema.parse(
      {},
    ) as Parameters<typeof clearPrimaryCalendarTool.handler>[0];
    try {
      await clearPrimaryCalendarTool.handler(parsed, {
        client: client as unknown as never,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const e = err as ConfirmRequiredError;
      expect(e.preview.toLowerCase()).toContain("primary");
      expect(e.preview.toLowerCase()).toContain("irreversible");
    }
  });

  it("calls client.clearPrimaryCalendar when confirmed and returns cleared: true", async () => {
    const client = makeClient({
      clearPrimaryCalendar: vi.fn().mockResolvedValue(undefined),
    });
    const parsed = clearPrimaryCalendarTool.inputSchema.parse({
      confirm: true,
    }) as Parameters<typeof clearPrimaryCalendarTool.handler>[0];
    const out = await clearPrimaryCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.clearPrimaryCalendar).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ cleared: true });
  });
});
