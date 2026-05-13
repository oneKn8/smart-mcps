import { describe, it, expect, vi } from "vitest";
import { listUserSettingsTool, getUserSettingTool } from "../settings.js";

type FakeClient = {
  listSettings: ReturnType<typeof vi.fn>;
  getSetting: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    listSettings: vi.fn(),
    getSetting: vi.fn(),
    ...over,
  };
}

// =============================================================================
// list_user_settings
// =============================================================================

describe("listUserSettingsTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(listUserSettingsTool.name).toBe("list_user_settings");
    expect(listUserSettingsTool.description).toBe(
      "List your calendar preferences",
    );
    expect(
      listUserSettingsTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("accepts an empty input", () => {
    expect(() => listUserSettingsTool.inputSchema.parse({})).not.toThrow();
  });
});

describe("listUserSettingsTool — handler", () => {
  it("flattens items[{id,value}] into a flat record", async () => {
    const client = makeClient({
      listSettings: vi.fn().mockResolvedValue([
        { id: "timezone", value: "America/Chicago" },
        { id: "weekStart", value: "1" },
        { id: "format24HourTime", value: "false" },
      ]),
    });

    const out = await listUserSettingsTool.handler({}, {
      client: client as unknown as never,
    });

    expect(out.settings).toEqual({
      timezone: "America/Chicago",
      weekStart: "1",
      format24HourTime: "false",
    });
  });

  it("returns an empty record when there are no settings", async () => {
    const client = makeClient({
      listSettings: vi.fn().mockResolvedValue([]),
    });

    const out = await listUserSettingsTool.handler({}, {
      client: client as unknown as never,
    });

    expect(out.settings).toEqual({});
  });

  it("skips items missing id or value", async () => {
    const client = makeClient({
      listSettings: vi.fn().mockResolvedValue([
        { id: "timezone", value: "America/Chicago" },
        { id: "weekStart" }, // no value
        { value: "x" }, // no id
        { id: "", value: "y" }, // empty id
        null,
        "not-an-object",
        { id: "locale", value: 123 }, // non-string value
      ]),
    });

    const out = await listUserSettingsTool.handler({}, {
      client: client as unknown as never,
    });

    expect(out.settings).toEqual({ timezone: "America/Chicago" });
  });
});

// =============================================================================
// get_user_setting
// =============================================================================

describe("getUserSettingTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(getUserSettingTool.name).toBe("get_user_setting");
    expect(getUserSettingTool.description).toBe(
      "Get one calendar preference by ID",
    );
    expect(
      getUserSettingTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("requires setting_id", () => {
    expect(() => getUserSettingTool.inputSchema.parse({})).toThrow();
  });
});

describe("getUserSettingTool — handler", () => {
  it("returns the {id,value} pair from the upstream resource", async () => {
    const client = makeClient({
      getSetting: vi.fn().mockResolvedValue({
        id: "timezone",
        value: "America/Chicago",
      }),
    });

    const out = await getUserSettingTool.handler(
      { setting_id: "timezone" },
      { client: client as unknown as never },
    );

    expect(client.getSetting).toHaveBeenCalledWith("timezone");
    expect(out).toEqual({ id: "timezone", value: "America/Chicago" });
  });

  it("falls back to the input setting_id when upstream omits id", async () => {
    const client = makeClient({
      getSetting: vi.fn().mockResolvedValue({ value: "1" }),
    });

    const out = await getUserSettingTool.handler(
      { setting_id: "weekStart" },
      { client: client as unknown as never },
    );

    expect(out).toEqual({ id: "weekStart", value: "1" });
  });

  it("falls back to empty string when upstream omits value", async () => {
    const client = makeClient({
      getSetting: vi.fn().mockResolvedValue({ id: "timezone" }),
    });

    const out = await getUserSettingTool.handler(
      { setting_id: "timezone" },
      { client: client as unknown as never },
    );

    expect(out).toEqual({ id: "timezone", value: "" });
  });

  it("throws when upstream returns a non-object", async () => {
    const client = makeClient({
      getSetting: vi.fn().mockResolvedValue(null),
    });

    await expect(
      getUserSettingTool.handler(
        { setting_id: "timezone" },
        { client: client as unknown as never },
      ),
    ).rejects.toThrow();
  });
});
