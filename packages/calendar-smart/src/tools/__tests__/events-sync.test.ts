import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { syncEventsTool } from "../events-sync.js";

type FakeClient = {
  listEvents: ReturnType<typeof vi.fn>;
};

function makeClient(
  result: {
    items: unknown[];
    nextSyncToken?: string;
    syncTokenInvalid?: true;
  } = { items: [] },
): FakeClient {
  return { listEvents: vi.fn().mockResolvedValue(result) };
}

function rawEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt_alpha",
    summary: "Standup",
    start: { dateTime: "2026-05-13T10:00:00-05:00" },
    end: { dateTime: "2026-05-13T10:30:00-05:00" },
    htmlLink: "https://calendar.google.com/event?eid=alpha",
    status: "confirmed",
    ...over,
  };
}

describe("syncEventsTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(syncEventsTool.name).toBe("sync_events");
    expect(
      syncEventsTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema is a zod type with default calendar_id", () => {
    expect(syncEventsTool.inputSchema).toBeInstanceOf(z.ZodType);
    const parsed = syncEventsTool.inputSchema.parse({}) as {
      calendar_id: string;
    };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("syncEventsTool — handler", () => {
  it("initial call (no sync_token): requests showDeleted=true and returns next_sync_token", async () => {
    const client = makeClient({
      items: [rawEvent()],
      nextSyncToken: "tok_sync_emitted",
    });
    const parsed = syncEventsTool.inputSchema.parse({}) as Parameters<
      typeof syncEventsTool.handler
    >[0];

    const out = await syncEventsTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "primary",
      maxResults: 2500,
      showDeleted: true,
    });
    expect(out.events).toHaveLength(1);
    expect(out.next_sync_token).toBe("tok_sync_emitted");
    expect(out.full_resync_required).toBeUndefined();
  });

  it("subsequent call (with sync_token): forwards syncToken to client", async () => {
    const client = makeClient({
      items: [rawEvent({ id: "evt_changed" })],
      nextSyncToken: "tok_sync_next",
    });
    const parsed = syncEventsTool.inputSchema.parse({
      sync_token: "tok_sync_in",
      calendar_id: "cal_work",
    }) as Parameters<typeof syncEventsTool.handler>[0];

    const out = await syncEventsTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "cal_work",
      maxResults: 2500,
      showDeleted: true,
      syncToken: "tok_sync_in",
    });
    expect(out.events[0]?.id).toBe("evt_changed");
    expect(out.next_sync_token).toBe("tok_sync_next");
  });

  it("returns full_resync_required=true when client signals expired sync token", async () => {
    const client = makeClient({
      items: [],
      syncTokenInvalid: true,
    });
    const parsed = syncEventsTool.inputSchema.parse({
      sync_token: "tok_old",
    }) as Parameters<typeof syncEventsTool.handler>[0];

    const out = await syncEventsTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(out.events).toEqual([]);
    expect(out.next_sync_token).toBeNull();
    expect(out.full_resync_required).toBe(true);
  });

  it("returns next_sync_token=null when not present in the response", async () => {
    // Page-not-final response: nextSyncToken absent until the last page.
    const client = makeClient({ items: [rawEvent()] });
    const parsed = syncEventsTool.inputSchema.parse({}) as Parameters<
      typeof syncEventsTool.handler
    >[0];

    const out = await syncEventsTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.next_sync_token).toBeNull();
  });
});
