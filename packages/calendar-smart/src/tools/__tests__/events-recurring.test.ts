import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { listInstancesTool } from "../events-recurring.js";

type FakeClient = {
  listInstances?: ReturnType<typeof vi.fn>;
  patchEvent?: ReturnType<typeof vi.fn>;
  getEvent?: ReturnType<typeof vi.fn>;
  insertEvent?: ReturnType<typeof vi.fn>;
  getCalendarListEntry?: ReturnType<typeof vi.fn>;
};

function makeClient(over: FakeClient = {}): FakeClient {
  return {
    listInstances: vi
      .fn()
      .mockResolvedValue({ items: [], nextPageToken: undefined }),
    patchEvent: vi.fn().mockResolvedValue({}),
    getEvent: vi.fn().mockResolvedValue({}),
    insertEvent: vi.fn().mockResolvedValue({}),
    getCalendarListEntry: vi
      .fn()
      .mockResolvedValue({ id: "primary", summary: "Personal" }),
    ...over,
  };
}

function rawInstance(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt_alpha_20260513T150000Z",
    summary: "Standup",
    recurringEventId: "evt_alpha",
    originalStartTime: { dateTime: "2026-05-13T10:00:00-05:00" },
    start: { dateTime: "2026-05-13T10:00:00-05:00" },
    end: { dateTime: "2026-05-13T10:30:00-05:00" },
    htmlLink: "https://calendar.google.com/event?eid=alpha-1",
    status: "confirmed",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// listInstancesTool
// ---------------------------------------------------------------------------

describe("listInstancesTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(listInstancesTool.name).toBe("list_instances");
    expect(
      listInstancesTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires event_id and defaults calendar_id, max_results, show_deleted", () => {
    expect(() => listInstancesTool.inputSchema.parse({})).toThrow();
    const parsed = listInstancesTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as {
      calendar_id: string;
      max_results: number;
      show_deleted: boolean;
    };
    expect(parsed.calendar_id).toBe("primary");
    expect(parsed.max_results).toBe(25);
    expect(parsed.show_deleted).toBe(false);
  });

  it("inputSchema is a zod type", () => {
    expect(listInstancesTool.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("listInstancesTool — handler", () => {
  it("forwards calendar_id, event_id, defaults, and maps each instance to SlimEvent", async () => {
    const client = makeClient({
      listInstances: vi.fn().mockResolvedValue({
        items: [rawInstance(), rawInstance({ id: "evt_alpha_20260520T150000Z" })],
        nextPageToken: undefined,
      }),
    });
    const parsed = listInstancesTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as Parameters<typeof listInstancesTool.handler>[0];

    const out = await listInstancesTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listInstances).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
      maxResults: 25,
      showDeleted: false,
    });
    expect(out.instances).toHaveLength(2);
    expect(out.instances[0]?.recurring_event_id).toBe("evt_alpha");
    expect(out.instances[0]?.original_start_time).toBe(
      "2026-05-13T10:00:00-05:00",
    );
    expect(out.next_page_token).toBeNull();
  });

  it("forwards optional time_min, time_max, original_start when provided", async () => {
    const client = makeClient({
      listInstances: vi
        .fn()
        .mockResolvedValue({ items: [], nextPageToken: "tok_next" }),
    });
    const parsed = listInstancesTool.inputSchema.parse({
      event_id: "evt_alpha",
      calendar_id: "cal_work",
      time_min: "2026-05-13T00:00:00Z",
      time_max: "2026-05-20T00:00:00Z",
      original_start: "2026-05-13T15:00:00Z",
      show_deleted: true,
      max_results: 100,
    }) as Parameters<typeof listInstancesTool.handler>[0];

    const out = await listInstancesTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listInstances).toHaveBeenCalledWith({
      calendarId: "cal_work",
      eventId: "evt_alpha",
      maxResults: 100,
      showDeleted: true,
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-20T00:00:00Z",
      originalStart: "2026-05-13T15:00:00Z",
    });
    expect(out.next_page_token).toBe("tok_next");
  });

  it("preserves nextPageToken into next_page_token", async () => {
    const client = makeClient({
      listInstances: vi
        .fn()
        .mockResolvedValue({ items: [rawInstance()], nextPageToken: "abc" }),
    });
    const parsed = listInstancesTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as Parameters<typeof listInstancesTool.handler>[0];

    const out = await listInstancesTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.next_page_token).toBe("abc");
  });

  it("each instance carries calendar_id from the input", async () => {
    const client = makeClient({
      listInstances: vi
        .fn()
        .mockResolvedValue({ items: [rawInstance()], nextPageToken: undefined }),
    });
    const parsed = listInstancesTool.inputSchema.parse({
      event_id: "evt_alpha",
      calendar_id: "cal_work",
    }) as Parameters<typeof listInstancesTool.handler>[0];

    const out = await listInstancesTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.instances[0]?.calendar_id).toBe("cal_work");
  });
});
