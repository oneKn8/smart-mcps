import { describe, it, expect, vi } from "vitest";
import { subscribeCalendarTool } from "../calendar-subscriptions.js";

type FakeClient = {
  insertCalendarListEntry: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    insertCalendarListEntry: vi.fn(),
    ...over,
  };
}

const calTeamEntry: Record<string, unknown> = {
  id: "cal_team",
  summary: "Team",
  accessRole: "reader",
  timeZone: "America/Chicago",
  backgroundColor: "#0d58c7",
};

// ============================================================================
// subscribe_calendar
// ============================================================================

describe("subscribeCalendarTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(subscribeCalendarTool.name).toBe("subscribe_calendar");
    expect(subscribeCalendarTool.description).toBe(
      "Add an existing calendar to your sidebar",
    );
    expect(
      subscribeCalendarTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires calendar_id", () => {
    expect(() => subscribeCalendarTool.inputSchema.parse({})).toThrow();
  });
});

describe("subscribeCalendarTool — handler", () => {
  it("POSTs body with id + selected default true; no colorRgbFormat without hex", async () => {
    const client = makeClient({
      insertCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = subscribeCalendarTool.inputSchema.parse({
      calendar_id: "cal_team",
    }) as Parameters<typeof subscribeCalendarTool.handler>[0];

    const out = await subscribeCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertCalendarListEntry).toHaveBeenCalledWith({
      body: { id: "cal_team", selected: true, hidden: false },
    });
    expect(out.calendar.id).toBe("cal_team");
    expect(out.calendar.access_role).toBe("reader");
  });

  it("forwards color_id, summary_override, selected=false, hidden=true (no hex => no colorRgbFormat)", async () => {
    const client = makeClient({
      insertCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = subscribeCalendarTool.inputSchema.parse({
      calendar_id: "cal_team",
      color_id: "7",
      summary_override: "Team Cal",
      selected: false,
      hidden: true,
    }) as Parameters<typeof subscribeCalendarTool.handler>[0];

    await subscribeCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertCalendarListEntry).toHaveBeenCalledWith({
      body: {
        id: "cal_team",
        colorId: "7",
        summaryOverride: "Team Cal",
        selected: false,
        hidden: true,
      },
    });
  });

  it("adds colorRgbFormat=true when background_color or foreground_color is hex", async () => {
    const client = makeClient({
      insertCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = subscribeCalendarTool.inputSchema.parse({
      calendar_id: "cal_team",
      background_color: "#ff0000",
      foreground_color: "#ffffff",
    }) as Parameters<typeof subscribeCalendarTool.handler>[0];

    await subscribeCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertCalendarListEntry).toHaveBeenCalledWith({
      body: {
        id: "cal_team",
        backgroundColor: "#ff0000",
        foregroundColor: "#ffffff",
        selected: true,
        hidden: false,
      },
      colorRgbFormat: true,
    });
  });
});
