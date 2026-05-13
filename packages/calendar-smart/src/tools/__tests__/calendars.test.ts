import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { listCalendarsTool, getCalendarTool } from "../calendars.js";

type FakeListClient = {
  listCalendars: ReturnType<typeof vi.fn>;
};

type FakeGetClient = {
  getCalendarListEntry: ReturnType<typeof vi.fn>;
};

function makeListClient(items: Array<Record<string, unknown>>): FakeListClient {
  return {
    listCalendars: vi.fn().mockResolvedValue(items),
  };
}

function makeGetClient(item: Record<string, unknown>): FakeGetClient {
  return {
    getCalendarListEntry: vi.fn().mockResolvedValue(item),
  };
}

const calPersonal: Record<string, unknown> = {
  id: "primary",
  summary: "Personal",
  primary: true,
  timeZone: "America/Chicago",
  accessRole: "owner",
  backgroundColor: "#0d58c7",
};

const calWork: Record<string, unknown> = {
  id: "cal_work",
  summary: "Work",
  timeZone: "America/Chicago",
  accessRole: "writer",
};

// ============================================================================
// list_calendars
// ============================================================================

describe("listCalendarsTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(listCalendarsTool.name).toBe("list_calendars");
    expect(listCalendarsTool.description).toBe("List all your calendars");
    expect(
      listCalendarsTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
    expect(listCalendarsTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object and applies safe defaults", () => {
    const parsed = listCalendarsTool.inputSchema.parse({}) as {
      show_hidden: boolean;
      show_deleted: boolean;
      min_access_role?: string;
    };
    expect(parsed).toEqual({ show_hidden: false, show_deleted: false });
  });
});

describe("listCalendarsTool — handler", () => {
  it("maps every item via mapCalendar and returns under 'calendars'", async () => {
    const client = makeListClient([calPersonal, calWork]);
    const out = await listCalendarsTool.handler({}, {
      client: client as unknown as never,
    });
    expect(out.calendars).toHaveLength(2);
    expect(out.calendars[0]).toEqual({
      id: "primary",
      summary: "Personal",
      primary: true,
      time_zone: "America/Chicago",
      access_role: "owner",
      background_color: "#0d58c7",
      foreground_color: null,
      description: null,
      location: null,
      summary_override: null,
      selected: true,
      hidden: false,
    });
    expect(out.calendars[1]).toEqual({
      id: "cal_work",
      summary: "Work",
      primary: false,
      time_zone: "America/Chicago",
      access_role: "writer",
      background_color: null,
      foreground_color: null,
      description: null,
      location: null,
      summary_override: null,
      selected: true,
      hidden: false,
    });
  });

  it("returns an empty array when the client returns no calendars", async () => {
    const client = makeListClient([]);
    const out = await listCalendarsTool.handler({}, {
      client: client as unknown as never,
    });
    expect(out.calendars).toEqual([]);
  });

  it("forwards show_hidden, show_deleted, min_access_role to the client", async () => {
    const client = makeListClient([]);
    const parsed = listCalendarsTool.inputSchema.parse({
      show_hidden: true,
      show_deleted: true,
      min_access_role: "writer",
    }) as Parameters<typeof listCalendarsTool.handler>[0];
    await listCalendarsTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.listCalendars).toHaveBeenCalledWith({
      showHidden: true,
      showDeleted: true,
      minAccessRole: "writer",
    });
  });

  it("calls listCalendars with default-only opts when no filters set", async () => {
    const client = makeListClient([]);
    const parsed = listCalendarsTool.inputSchema.parse({}) as Parameters<
      typeof listCalendarsTool.handler
    >[0];
    await listCalendarsTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.listCalendars).toHaveBeenCalledWith({
      showHidden: false,
      showDeleted: false,
    });
  });

  it("rejects invalid min_access_role at the schema layer", () => {
    expect(() =>
      listCalendarsTool.inputSchema.parse({ min_access_role: "admin" }),
    ).toThrow();
  });
});

// ============================================================================
// get_calendar
// ============================================================================

describe("getCalendarTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(getCalendarTool.name).toBe("get_calendar");
    expect(getCalendarTool.description).toBe(
      "Get one calendar's details",
    );
    expect(
      getCalendarTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires calendar_id", () => {
    expect(() => getCalendarTool.inputSchema.parse({})).toThrow();
    const parsed = getCalendarTool.inputSchema.parse({
      calendar_id: "primary",
    }) as { calendar_id: string };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("getCalendarTool — handler", () => {
  it("calls client.getCalendarListEntry with the parsed calendar_id and maps", async () => {
    const client = makeGetClient(calWork);
    const parsed = getCalendarTool.inputSchema.parse({
      calendar_id: "cal_work",
    }) as Parameters<typeof getCalendarTool.handler>[0];
    const out = await getCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.getCalendarListEntry).toHaveBeenCalledWith("cal_work");
    expect(out.calendar).toEqual({
      id: "cal_work",
      summary: "Work",
      primary: false,
      time_zone: "America/Chicago",
      access_role: "writer",
      background_color: null,
      foreground_color: null,
      description: null,
      location: null,
      summary_override: null,
      selected: true,
      hidden: false,
    });
  });
});
