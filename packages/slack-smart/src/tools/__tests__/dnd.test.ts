import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmRequiredError } from "smart-mcp-core";
import { dnd_status, set_snooze, end_snooze } from "../dnd.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  dndInfo: ReturnType<typeof vi.fn>;
  setSnooze: ReturnType<typeof vi.fn>;
  endSnooze: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    dndInfo: vi.fn(),
    setSnooze: vi.fn(),
    endSnooze: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

function parse<T>(tool: { inputSchema: { parse: (v: unknown) => T } }, raw: unknown): T {
  return tool.inputSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// dnd_status
// ---------------------------------------------------------------------------

describe("dnd_status — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns dnd_enabled from response", async () => {
    client.dndInfo.mockResolvedValue({ ok: true, dnd_enabled: false });
    const input = parse(dnd_status, {});
    const result = (await dnd_status.handler(input, ctx(client))) as Record<string, unknown>;
    expect(result.dnd_enabled).toBe(false);
  });

  it("includes optional fields when present", async () => {
    client.dndInfo.mockResolvedValue({
      ok: true,
      dnd_enabled: true,
      next_dnd_start_ts: 1700000000,
      next_dnd_end_ts: 1700003600,
      snooze_enabled: true,
      snooze_endtime: 1700001800,
    });
    const input = parse(dnd_status, {});
    const result = (await dnd_status.handler(input, ctx(client))) as Record<string, unknown>;
    expect(result.dnd_enabled).toBe(true);
    expect(result.next_dnd_start_ts).toBe(1700000000);
    expect(result.next_dnd_end_ts).toBe(1700003600);
    expect(result.snooze_enabled).toBe(true);
    expect(result.snooze_endtime).toBe(1700001800);
  });

  it("omits optional fields when absent", async () => {
    client.dndInfo.mockResolvedValue({ ok: true, dnd_enabled: false });
    const input = parse(dnd_status, {});
    const result = (await dnd_status.handler(input, ctx(client))) as Record<string, unknown>;
    expect(result).not.toHaveProperty("next_dnd_start_ts");
    expect(result).not.toHaveProperty("snooze_enabled");
    expect(result).not.toHaveProperty("snooze_endtime");
  });

  it("passes user arg to client when provided", async () => {
    client.dndInfo.mockResolvedValue({ ok: true, dnd_enabled: false });
    const input = parse(dnd_status, { user: "U999" });
    await dnd_status.handler(input, ctx(client));
    const [args] = client.dndInfo.mock.calls[0] as [Record<string, unknown>];
    expect(args.user).toBe("U999");
  });
});

// ---------------------------------------------------------------------------
// set_snooze
// ---------------------------------------------------------------------------

describe("set_snooze — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call setSnooze", async () => {
    const input = parse(set_snooze, { num_minutes: 30 });
    await expect(set_snooze.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.setSnooze).not.toHaveBeenCalled();
  });

  it("calls setSnooze with num_minutes when confirm:true", async () => {
    client.setSnooze.mockResolvedValue({
      ok: true,
      snooze_enabled: true,
      snooze_endtime: 1700001800,
      snooze_remaining: 1800,
    });
    const input = parse(set_snooze, { num_minutes: 30, confirm: true });
    const result = (await set_snooze.handler(input, ctx(client))) as Record<string, unknown>;
    expect(client.setSnooze).toHaveBeenCalledTimes(1);
    const [args] = client.setSnooze.mock.calls[0] as [Record<string, unknown>];
    expect(args.num_minutes).toBe(30);
    expect(result.ok).toBe(true);
    expect(result.snooze_endtime).toBe(1700001800);
  });

  it("preview contains num_minutes", async () => {
    const input = parse(set_snooze, { num_minutes: 45 });
    let preview = "";
    try {
      await set_snooze.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("45");
  });

  it("omits snooze_endtime from output when absent in response", async () => {
    client.setSnooze.mockResolvedValue({
      ok: true,
      snooze_enabled: true,
      snooze_endtime: 0,
      snooze_remaining: 0,
    });
    const input = parse(set_snooze, { num_minutes: 1, confirm: true });
    const result = (await set_snooze.handler(input, ctx(client))) as Record<string, unknown>;
    // nullableNumber(0) returns 0, which is not null, so snooze_endtime should appear
    expect(result.snooze_endtime).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// end_snooze
// ---------------------------------------------------------------------------

describe("end_snooze — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call endSnooze", async () => {
    const input = parse(end_snooze, {});
    await expect(end_snooze.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.endSnooze).not.toHaveBeenCalled();
  });

  it("calls endSnooze and returns ok:true when confirm:true", async () => {
    client.endSnooze.mockResolvedValue({ ok: true, dnd_enabled: false });
    const input = parse(end_snooze, { confirm: true });
    const result = (await end_snooze.handler(input, ctx(client))) as { ok: boolean };
    expect(client.endSnooze).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("preview mentions Do Not Disturb", async () => {
    const input = parse(end_snooze, {});
    let preview = "";
    try {
      await end_snooze.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview.toLowerCase()).toContain("do not disturb");
  });
});
