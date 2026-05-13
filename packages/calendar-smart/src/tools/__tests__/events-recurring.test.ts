import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  ConfirmRequiredError,
  ValidationError,
} from "smart-mcp-core";
import {
  listInstancesTool,
  updateInstanceTool,
  cancelInstanceTool,
  splitRecurrenceTool,
} from "../events-recurring.js";

type FakeClient = {
  listInstances?: ReturnType<typeof vi.fn>;
  patchEvent?: ReturnType<typeof vi.fn>;
  getEvent?: ReturnType<typeof vi.fn>;
  insertEvent?: ReturnType<typeof vi.fn>;
  getCalendarListEntry?: ReturnType<typeof vi.fn>;
  ensureTimeZone?: ReturnType<typeof vi.fn>;
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
    ensureTimeZone: vi.fn().mockResolvedValue("America/Chicago"),
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

// ---------------------------------------------------------------------------
// updateInstanceTool
// ---------------------------------------------------------------------------

describe("updateInstanceTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(updateInstanceTool.name).toBe("update_instance");
    expect(
      updateInstanceTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires instance_id and defaults calendar_id", () => {
    expect(() => updateInstanceTool.inputSchema.parse({})).toThrow();
    const parsed = updateInstanceTool.inputSchema.parse({
      instance_id: "evt_alpha_20260513T150000Z",
    }) as { calendar_id: string };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("updateInstanceTool — handler", () => {
  it("PATCHes the instance id with the supplied fields", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawInstance({ summary: "Renamed" })),
    });
    const parsed = updateInstanceTool.inputSchema.parse({
      instance_id: "evt_alpha_20260513T150000Z",
      summary: "Renamed",
      location: "Conf Room A",
    }) as Parameters<typeof updateInstanceTool.handler>[0];

    await updateInstanceTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha_20260513T150000Z",
      body: { summary: "Renamed", location: "Conf Room A" },
      sendUpdates: "none",
    });
  });

  it("rejects event_type on instance updates with a ValidationError", () => {
    expect(() =>
      updateInstanceTool.inputSchema.parse({
        instance_id: "evt_alpha_20260513T150000Z",
        event_type: "focusTime",
      }),
    ).not.toThrow(); // schema accepts it; guard fires in handler

    const parsed = updateInstanceTool.inputSchema.parse({
      instance_id: "evt_alpha_20260513T150000Z",
      event_type: "focusTime",
    }) as Parameters<typeof updateInstanceTool.handler>[0];

    return expect(
      updateInstanceTool.handler(parsed, {
        client: makeClient() as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("forwards conferenceDataVersion=1 when create_meet_link is true", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawInstance()),
    });
    const parsed = updateInstanceTool.inputSchema.parse({
      instance_id: "evt_alpha_20260513T150000Z",
      create_meet_link: true,
    }) as Parameters<typeof updateInstanceTool.handler>[0];

    await updateInstanceTool.handler(parsed, {
      client: client as unknown as never,
    });

    const call = (client.patchEvent as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call.conferenceDataVersion).toBe(1);
  });

  it("returns the mapped SlimEvent of the patched instance", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawInstance({ summary: "Done" })),
    });
    const parsed = updateInstanceTool.inputSchema.parse({
      instance_id: "evt_alpha_20260513T150000Z",
      summary: "Done",
    }) as Parameters<typeof updateInstanceTool.handler>[0];

    const out = await updateInstanceTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.event.summary).toBe("Done");
    expect(out.event.recurring_event_id).toBe("evt_alpha");
  });
});

// ---------------------------------------------------------------------------
// cancelInstanceTool
// ---------------------------------------------------------------------------

describe("cancelInstanceTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(cancelInstanceTool.name).toBe("cancel_instance");
    expect(
      cancelInstanceTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });
});

describe("cancelInstanceTool — handler", () => {
  it("throws ConfirmRequiredError with a meaningful preview when confirm=false", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(rawInstance({ summary: "Standup" })),
      getCalendarListEntry: vi
        .fn()
        .mockResolvedValue({ id: "primary", summary: "Personal" }),
    });
    const parsed = cancelInstanceTool.inputSchema.parse({
      instance_id: "evt_alpha_20260513T150000Z",
    }) as Parameters<typeof cancelInstanceTool.handler>[0];

    await expect(
      cancelInstanceTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    await expect(
      cancelInstanceTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toMatchObject({
      preview: expect.stringContaining("Standup"),
    });
    // patchEvent must NOT have been called yet.
    expect(client.patchEvent).not.toHaveBeenCalled();
  });

  it("preview names the originalStartTime when present", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(rawInstance()),
    });
    const parsed = cancelInstanceTool.inputSchema.parse({
      instance_id: "evt_alpha_20260513T150000Z",
    }) as Parameters<typeof cancelInstanceTool.handler>[0];

    await expect(
      cancelInstanceTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toMatchObject({
      preview: expect.stringContaining("2026-05-13T10:00:00-05:00"),
    });
  });

  it("PATCHes the instance with status=cancelled when confirm=true", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(rawInstance()),
      patchEvent: vi.fn().mockResolvedValue({}),
    });
    const parsed = cancelInstanceTool.inputSchema.parse({
      instance_id: "evt_alpha_20260513T150000Z",
      confirm: true,
    }) as Parameters<typeof cancelInstanceTool.handler>[0];

    const out = await cancelInstanceTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha_20260513T150000Z",
      body: { status: "cancelled" },
    });
    expect(out).toEqual({ cancelled: true });
  });

  it("falls back to the bare calendar id when getCalendarListEntry fails", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(rawInstance()),
      getCalendarListEntry: vi
        .fn()
        .mockRejectedValue(new Error("boom")),
    });
    const parsed = cancelInstanceTool.inputSchema.parse({
      instance_id: "evt_alpha_20260513T150000Z",
    }) as Parameters<typeof cancelInstanceTool.handler>[0];

    await expect(
      cancelInstanceTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toMatchObject({
      preview: expect.stringContaining("primary"),
    });
  });
});

// ---------------------------------------------------------------------------
// splitRecurrenceTool
// ---------------------------------------------------------------------------

function rawMasterSeries(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "evt_alpha",
    summary: "Weekly standup",
    start: { dateTime: "2026-04-06T10:00:00-05:00" },
    end: { dateTime: "2026-04-06T10:30:00-05:00" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    htmlLink: "https://calendar.google.com/event?eid=alpha",
    status: "confirmed",
    ...over,
  };
}

describe("splitRecurrenceTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(splitRecurrenceTool.name).toBe("split_recurrence");
    expect(
      splitRecurrenceTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires event_id, target_start, new_event and defaults calendar_id", () => {
    expect(() => splitRecurrenceTool.inputSchema.parse({})).toThrow();
    const parsed = splitRecurrenceTool.inputSchema.parse({
      event_id: "evt_alpha",
      target_start: "2026-06-01T10:00:00-05:00",
      new_event: {
        summary: "Weekly standup (new)",
        start: "2026-06-01T10:00:00-05:00",
        end: "2026-06-01T10:30:00-05:00",
      },
    }) as { calendar_id: string; confirm: boolean };
    expect(parsed.calendar_id).toBe("primary");
    expect(parsed.confirm).toBe(false);
  });
});

describe("splitRecurrenceTool — handler", () => {
  it("throws ConfirmRequiredError with a meaningful preview when confirm=false", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(rawMasterSeries()),
    });
    const parsed = splitRecurrenceTool.inputSchema.parse({
      event_id: "evt_alpha",
      target_start: "2026-06-01T10:00:00-05:00",
      new_event: {
        summary: "Weekly standup (new)",
        start: "2026-06-01T10:00:00-05:00",
        end: "2026-06-01T10:30:00-05:00",
      },
    }) as Parameters<typeof splitRecurrenceTool.handler>[0];

    await expect(
      splitRecurrenceTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.patchEvent).not.toHaveBeenCalled();
    expect(client.insertEvent).not.toHaveBeenCalled();
  });

  it("when confirmed: caps the master series via UNTIL then inserts a new series", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(rawMasterSeries()),
      patchEvent: vi
        .fn()
        .mockResolvedValue(
          rawMasterSeries({
            recurrence: [
              "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T145959Z",
            ],
          }),
        ),
      insertEvent: vi.fn().mockResolvedValue({
        id: "evt_beta",
        summary: "Weekly standup (new)",
        start: { dateTime: "2026-06-01T10:00:00-05:00" },
        end: { dateTime: "2026-06-01T10:30:00-05:00" },
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        status: "confirmed",
        htmlLink: "https://calendar.google.com/event?eid=beta",
      }),
    });
    const parsed = splitRecurrenceTool.inputSchema.parse({
      event_id: "evt_alpha",
      // 2026-06-01T15:00:00Z → minus 1s → 2026-06-01T14:59:59Z → 20260601T145959Z
      target_start: "2026-06-01T15:00:00Z",
      new_event: {
        summary: "Weekly standup (new)",
        start: "2026-06-01T10:00:00-05:00",
        end: "2026-06-01T10:30:00-05:00",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      },
      confirm: true,
    }) as Parameters<typeof splitRecurrenceTool.handler>[0];

    const out = await splitRecurrenceTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchEvent).toHaveBeenCalledTimes(1);
    const patchCall = (client.patchEvent as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(patchCall.calendarId).toBe("primary");
    expect(patchCall.eventId).toBe("evt_alpha");
    expect(patchCall.body.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T145959Z",
    ]);

    expect(client.insertEvent).toHaveBeenCalledTimes(1);
    const insertCall = (client.insertEvent as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(insertCall.calendarId).toBe("primary");
    expect(insertCall.body.summary).toBe("Weekly standup (new)");
    expect(insertCall.body.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    ]);

    expect(out.truncated_series.id).toBe("evt_alpha");
    expect(out.new_series.id).toBe("evt_beta");
  });

  it("computes UNTIL as (target_start - 1s) in UTC YYYYMMDDTHHMMSSZ format", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(rawMasterSeries()),
      patchEvent: vi.fn().mockResolvedValue(rawMasterSeries()),
      insertEvent: vi.fn().mockResolvedValue(rawMasterSeries({ id: "evt_new" })),
    });
    const parsed = splitRecurrenceTool.inputSchema.parse({
      event_id: "evt_alpha",
      target_start: "2026-06-01T10:00:00-05:00",
      new_event: {
        summary: "x",
        start: "2026-06-01T10:00:00-05:00",
        end: "2026-06-01T10:30:00-05:00",
      },
      confirm: true,
    }) as Parameters<typeof splitRecurrenceTool.handler>[0];

    await splitRecurrenceTool.handler(parsed, {
      client: client as unknown as never,
    });

    const patchCall = (client.patchEvent as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    // 2026-06-01T10:00:00-05:00 = 15:00:00Z → minus 1s = 14:59:59Z
    expect(patchCall.body.recurrence[0]).toContain("UNTIL=20260601T145959Z");
  });

  it("throws when the master event has no recurrence rule", async () => {
    const client = makeClient({
      getEvent: vi
        .fn()
        .mockResolvedValue(rawMasterSeries({ recurrence: undefined })),
    });
    const parsed = splitRecurrenceTool.inputSchema.parse({
      event_id: "evt_alpha",
      target_start: "2026-06-01T10:00:00-05:00",
      new_event: {
        summary: "x",
        start: "2026-06-01T10:00:00-05:00",
        end: "2026-06-01T10:30:00-05:00",
      },
      confirm: true,
    }) as Parameters<typeof splitRecurrenceTool.handler>[0];

    await expect(
      splitRecurrenceTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
