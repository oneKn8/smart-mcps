import { describe, it, expect, vi } from "vitest";
import { moveEventTool } from "../events-move.js";

type FakeClient = {
  moveEvent: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    moveEvent: vi.fn(),
    ...over,
  };
}

const movedEvent: Record<string, unknown> = {
  id: "evt_alpha",
  summary: "Standup",
  start: { dateTime: "2026-05-13T15:00:00-05:00" },
  end: { dateTime: "2026-05-13T15:30:00-05:00" },
  status: "confirmed",
  htmlLink: "https://calendar.google.com/event?eid=evt_alpha",
};

describe("moveEventTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(moveEventTool.name).toBe("move_event");
    expect(moveEventTool.description).toBe(
      "Move event to another calendar",
    );
    expect(
      moveEventTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("requires event_id and destination_calendar_id", () => {
    expect(() => moveEventTool.inputSchema.parse({})).toThrow();
    expect(() =>
      moveEventTool.inputSchema.parse({ event_id: "x" }),
    ).toThrow();
  });

  it("source_calendar_id defaults to 'primary'; send_updates defaults to 'none'", () => {
    const parsed = moveEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      destination_calendar_id: "cal_work",
    }) as { source_calendar_id: string; send_updates: string };
    expect(parsed.source_calendar_id).toBe("primary");
    expect(parsed.send_updates).toBe("none");
  });
});

describe("moveEventTool — handler", () => {
  it("calls moveEvent with the resolved source/destination/sendUpdates", async () => {
    const client = makeClient({
      moveEvent: vi.fn().mockResolvedValue(movedEvent),
    });
    const parsed = moveEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      destination_calendar_id: "cal_work",
    }) as Parameters<typeof moveEventTool.handler>[0];

    await moveEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.moveEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
      destination: "cal_work",
      sendUpdates: "none",
    });
  });

  it("forwards explicit source_calendar_id and send_updates", async () => {
    const client = makeClient({
      moveEvent: vi.fn().mockResolvedValue(movedEvent),
    });
    const parsed = moveEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      source_calendar_id: "cal_personal",
      destination_calendar_id: "cal_work",
      send_updates: "all",
    }) as Parameters<typeof moveEventTool.handler>[0];

    await moveEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.moveEvent).toHaveBeenCalledWith({
      calendarId: "cal_personal",
      eventId: "evt_alpha",
      destination: "cal_work",
      sendUpdates: "all",
    });
  });

  it("returns a mapped SlimEvent with calendar_id set to the destination", async () => {
    const client = makeClient({
      moveEvent: vi.fn().mockResolvedValue(movedEvent),
    });
    const parsed = moveEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      destination_calendar_id: "cal_work",
    }) as Parameters<typeof moveEventTool.handler>[0];

    const out = await moveEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(out.event.id).toBe("evt_alpha");
    expect(out.event.calendar_id).toBe("cal_work");
    expect(out.event.summary).toBe("Standup");
  });

  it("rejects send_updates values outside the enum", () => {
    expect(() =>
      moveEventTool.inputSchema.parse({
        event_id: "evt_alpha",
        destination_calendar_id: "cal_work",
        send_updates: "everyone",
      }),
    ).toThrow();
  });
});
