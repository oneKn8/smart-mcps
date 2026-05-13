import { describe, it, expect, vi } from "vitest";
import {
  createCalendarTool,
  updateCalendarTool,
} from "../calendars-write.js";

type FakeClient = {
  insertCalendar: ReturnType<typeof vi.fn>;
  patchCalendar: ReturnType<typeof vi.fn>;
  getCalendarListEntry: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    insertCalendar: vi.fn(),
    patchCalendar: vi.fn(),
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
