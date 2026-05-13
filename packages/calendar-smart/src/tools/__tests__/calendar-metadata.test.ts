import { describe, it, expect, vi } from "vitest";
import { getCalendarMetadataTool } from "../calendar-metadata.js";

type FakeClient = {
  getCalendarMetadata: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    getCalendarMetadata: vi.fn(),
    ...over,
  };
}

const SLIM_KEYS = [
  "id",
  "summary",
  "description",
  "location",
  "time_zone",
  "conference_properties",
];

describe("getCalendarMetadataTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(getCalendarMetadataTool.name).toBe("get_calendar_metadata");
    expect(getCalendarMetadataTool.description).toBe(
      "Get a calendar's bare metadata fields",
    );
    expect(
      getCalendarMetadataTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("requires calendar_id", () => {
    expect(() => getCalendarMetadataTool.inputSchema.parse({})).toThrow();
  });
});

describe("getCalendarMetadataTool — handler", () => {
  it("maps the bare /calendars/{id} resource", async () => {
    const client = makeClient({
      getCalendarMetadata: vi.fn().mockResolvedValue({
        kind: "calendar#calendar",
        etag: "etag-abc",
        id: "cal_work",
        summary: "Work",
        description: "Work calendar",
        location: "Dallas, TX",
        timeZone: "America/Chicago",
        conferenceProperties: {
          allowedConferenceSolutionTypes: ["hangoutsMeet"],
        },
      }),
    });

    const out = await getCalendarMetadataTool.handler(
      { calendar_id: "cal_work" },
      { client: client as unknown as never },
    );

    expect(client.getCalendarMetadata).toHaveBeenCalledWith("cal_work");
    expect(out).toEqual({
      id: "cal_work",
      summary: "Work",
      description: "Work calendar",
      location: "Dallas, TX",
      time_zone: "America/Chicago",
      conference_properties: { allowed_solution_types: ["hangoutsMeet"] },
    });
  });

  it("strips upstream noise (kind, etag) — exactly 6 slim keys", async () => {
    const client = makeClient({
      getCalendarMetadata: vi.fn().mockResolvedValue({
        kind: "calendar#calendar",
        etag: "etag-abc",
        id: "cal_work",
        summary: "Work",
        timeZone: "America/Chicago",
      }),
    });

    const out = await getCalendarMetadataTool.handler(
      { calendar_id: "cal_work" },
      { client: client as unknown as never },
    );

    expect(Object.keys(out).sort()).toEqual([...SLIM_KEYS].sort());
  });

  it("description and location degrade to null when absent", async () => {
    const client = makeClient({
      getCalendarMetadata: vi.fn().mockResolvedValue({
        id: "cal_x",
        summary: "X",
        timeZone: "America/Chicago",
      }),
    });

    const out = await getCalendarMetadataTool.handler(
      { calendar_id: "cal_x" },
      { client: client as unknown as never },
    );

    expect(out.description).toBeNull();
    expect(out.location).toBeNull();
  });

  it("conference_properties degrades to null when the block is absent", async () => {
    const client = makeClient({
      getCalendarMetadata: vi.fn().mockResolvedValue({
        id: "cal_x",
        summary: "X",
        timeZone: "America/Chicago",
      }),
    });

    const out = await getCalendarMetadataTool.handler(
      { calendar_id: "cal_x" },
      { client: client as unknown as never },
    );

    expect(out.conference_properties).toBeNull();
  });

  it("conference_properties degrades to null when the inner array is missing", async () => {
    const client = makeClient({
      getCalendarMetadata: vi.fn().mockResolvedValue({
        id: "cal_x",
        summary: "X",
        timeZone: "America/Chicago",
        conferenceProperties: {},
      }),
    });

    const out = await getCalendarMetadataTool.handler(
      { calendar_id: "cal_x" },
      { client: client as unknown as never },
    );

    expect(out.conference_properties).toBeNull();
  });

  it("conference_properties returns an empty array when the upstream array is empty", async () => {
    const client = makeClient({
      getCalendarMetadata: vi.fn().mockResolvedValue({
        id: "cal_x",
        summary: "X",
        timeZone: "America/Chicago",
        conferenceProperties: { allowedConferenceSolutionTypes: [] },
      }),
    });

    const out = await getCalendarMetadataTool.handler(
      { calendar_id: "cal_x" },
      { client: client as unknown as never },
    );

    expect(out.conference_properties).toEqual({ allowed_solution_types: [] });
  });

  it("missing summary degrades to empty string", async () => {
    const client = makeClient({
      getCalendarMetadata: vi.fn().mockResolvedValue({
        id: "cal_x",
        timeZone: "America/Chicago",
      }),
    });

    const out = await getCalendarMetadataTool.handler(
      { calendar_id: "cal_x" },
      { client: client as unknown as never },
    );

    expect(out.summary).toBe("");
  });

  it("throws when upstream returns a non-object", async () => {
    const client = makeClient({
      getCalendarMetadata: vi.fn().mockResolvedValue(null),
    });

    await expect(
      getCalendarMetadataTool.handler(
        { calendar_id: "cal_x" },
        { client: client as unknown as never },
      ),
    ).rejects.toThrow();
  });
});
