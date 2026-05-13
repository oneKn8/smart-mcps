import { describe, it, expect, vi } from "vitest";
import { getColorsTool } from "../colors.js";

type FakeClient = {
  getColors: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    getColors: vi.fn(),
    ...over,
  };
}

describe("getColorsTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(getColorsTool.name).toBe("get_colors");
    expect(getColorsTool.description).toBe(
      "Get event and calendar color palettes",
    );
    expect(
      getColorsTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("accepts an empty input", () => {
    expect(() => getColorsTool.inputSchema.parse({})).not.toThrow();
  });
});

describe("getColorsTool — handler", () => {
  it("maps event + calendar palettes and the updated timestamp", async () => {
    const client = makeClient({
      getColors: vi.fn().mockResolvedValue({
        kind: "calendar#colors",
        updated: "2026-05-13T00:00:00Z",
        calendar: {
          "1": { background: "#ac725e", foreground: "#1d1d1d" },
          "2": { background: "#d06b64", foreground: "#1d1d1d" },
        },
        event: {
          "1": { background: "#a4bdfc", foreground: "#1d1d1d" },
          "11": { background: "#dc2127", foreground: "#1d1d1d" },
        },
      }),
    });

    const out = await getColorsTool.handler({}, {
      client: client as unknown as never,
    });

    expect(out).toEqual({
      event_colors: {
        "1": { background: "#a4bdfc", foreground: "#1d1d1d" },
        "11": { background: "#dc2127", foreground: "#1d1d1d" },
      },
      calendar_colors: {
        "1": { background: "#ac725e", foreground: "#1d1d1d" },
        "2": { background: "#d06b64", foreground: "#1d1d1d" },
      },
      updated: "2026-05-13T00:00:00Z",
    });
  });

  it("strips upstream noise (kind, etag) from the output", async () => {
    const client = makeClient({
      getColors: vi.fn().mockResolvedValue({
        kind: "calendar#colors",
        etag: "etag-abc",
        updated: "2026-05-13T00:00:00Z",
        calendar: { "1": { background: "#ac725e", foreground: "#1d1d1d" } },
        event: { "1": { background: "#a4bdfc", foreground: "#1d1d1d" } },
      }),
    });

    const out = await getColorsTool.handler({}, {
      client: client as unknown as never,
    });

    expect(Object.keys(out).sort()).toEqual([
      "calendar_colors",
      "event_colors",
      "updated",
    ]);
  });

  it("drops palette entries missing background or foreground", async () => {
    const client = makeClient({
      getColors: vi.fn().mockResolvedValue({
        updated: "2026-05-13T00:00:00Z",
        calendar: {
          "1": { background: "#ac725e", foreground: "#1d1d1d" },
          "2": { background: "#d06b64" }, // missing foreground
          "3": { foreground: "#fff" }, // missing background
          "4": null,
        },
        event: {},
      }),
    });

    const out = await getColorsTool.handler({}, {
      client: client as unknown as never,
    });

    expect(out.calendar_colors).toEqual({
      "1": { background: "#ac725e", foreground: "#1d1d1d" },
    });
  });

  it("returns empty palettes and updated='' when the upstream is bare", async () => {
    const client = makeClient({
      getColors: vi.fn().mockResolvedValue({}),
    });

    const out = await getColorsTool.handler({}, {
      client: client as unknown as never,
    });

    expect(out).toEqual({
      event_colors: {},
      calendar_colors: {},
      updated: "",
    });
  });

  it("throws when upstream returns a non-object", async () => {
    const client = makeClient({
      getColors: vi.fn().mockResolvedValue(null),
    });

    await expect(
      getColorsTool.handler({}, { client: client as unknown as never }),
    ).rejects.toThrow();
  });
});
