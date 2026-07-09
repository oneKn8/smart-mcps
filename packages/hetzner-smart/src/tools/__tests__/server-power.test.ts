import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError } from "smart-mcp-core";
import { powerOn, powerOff, reboot, reset } from "../server-power.js";

// A settled action envelope. status:"success" so settleAction never reaches
// client.waitForAction — the summary comes straight back.
const sampleAction = {
  id: 42,
  command: "start_server",
  status: "success",
  progress: 100,
  started: "2026-01-01T00:00:00Z",
  finished: "2026-01-01T00:00:05Z",
  resources: [{ id: 1, type: "server" }],
  error: null,
};

// A raw upstream server body (extra fields present) so mapServer yields a name.
const sampleServer = {
  id: 1,
  name: "web-01",
  status: "running",
  public_net: { ipv4: { ip: "1.2.3.4" }, ipv6: { ip: "::1" } },
  server_type: { name: "cx11", cores: 1, memory: 2, disk: 20, architecture: "x86" },
  location: { name: "fsn1" },
  labels: {},
};

type FakeClient = {
  serverAction: ReturnType<typeof vi.fn>;
  getServer: ReturnType<typeof vi.fn>;
  extractAction: ReturnType<typeof vi.fn>;
  waitForAction: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    serverAction: vi.fn().mockResolvedValue({ action: sampleAction }),
    getServer: vi.fn().mockResolvedValue(sampleServer),
    // Mirror the real client.extractAction: pull `action` out of the body.
    extractAction: vi.fn((body: unknown) => {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const a = (body as Record<string, unknown>).action;
        if (a && typeof a === "object") return a;
      }
      return undefined;
    }),
    waitForAction: vi.fn().mockResolvedValue(sampleAction),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeClient> = {}): {
  client: never;
} {
  return { client: makeClient(overrides) as unknown as never };
}

// Pull the fake client back out of a ctx for assertions.
function clientOf(ctx: { client: never }): FakeClient {
  return ctx.client as unknown as FakeClient;
}

const OUTPUT_KEYS = ["server_id", "action"].sort();

// =============================================================================
// power_on
// =============================================================================

describe("powerOn — metadata + schema", () => {
  it("has the expected name, a non-empty description, and a zod schema", () => {
    expect(powerOn.name).toBe("power_on");
    expect(powerOn.description.length).toBeGreaterThan(0);
    expect(powerOn.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = powerOn.inputSchema.parse({ server_id: 1 }) as {
      wait: boolean;
    };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive server_id", () => {
    expect(() => powerOn.inputSchema.parse({ server_id: 0 })).toThrow();
    expect(() => powerOn.inputSchema.parse({ server_id: -3 })).toThrow();
  });

  it("rejects a missing server_id", () => {
    expect(() => powerOn.inputSchema.parse({})).toThrow();
  });
});

describe("powerOn — handler", () => {
  it("calls serverAction(id, 'poweron')", async () => {
    const ctx = makeCtx();
    const client = clientOf(ctx);
    await powerOn.handler(powerOn.inputSchema.parse({ server_id: 7 }), ctx);
    expect(client.serverAction).toHaveBeenCalledTimes(1);
    expect(client.serverAction).toHaveBeenCalledWith(7, "poweron");
  });

  it("returns only server_id and action", async () => {
    const ctx = makeCtx();
    const result = (await powerOn.handler(
      powerOn.inputSchema.parse({ server_id: 7 }),
      ctx,
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(OUTPUT_KEYS);
    expect(result.server_id).toBe(7);
    expect(result.action).toEqual({
      id: 42,
      command: "start_server",
      status: "success",
      progress: 100,
      finished: "2026-01-01T00:00:05Z",
    });
  });
});

// =============================================================================
// power_off
// =============================================================================

describe("powerOff — metadata + schema", () => {
  it("has the expected name, a non-empty description, and a zod schema", () => {
    expect(powerOff.name).toBe("power_off");
    expect(powerOff.description.length).toBeGreaterThan(0);
    expect(powerOff.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = powerOff.inputSchema.parse({ server_id: 1 }) as {
      wait: boolean;
    };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive server_id", () => {
    expect(() => powerOff.inputSchema.parse({ server_id: 0 })).toThrow();
  });
});

describe("powerOff — handler (not confirm-gated)", () => {
  it("calls serverAction(id, 'poweroff') without requiring confirm", async () => {
    const ctx = makeCtx();
    const client = clientOf(ctx);
    const result = (await powerOff.handler(
      powerOff.inputSchema.parse({ server_id: 3 }),
      ctx,
    )) as Record<string, unknown>;
    expect(client.serverAction).toHaveBeenCalledWith(3, "poweroff");
    expect(Object.keys(result).sort()).toEqual(OUTPUT_KEYS);
    expect(result.server_id).toBe(3);
  });
});

// =============================================================================
// reboot
// =============================================================================

describe("reboot — metadata + schema", () => {
  it("has the expected name, a non-empty description, and a zod schema", () => {
    expect(reboot.name).toBe("reboot");
    expect(reboot.description.length).toBeGreaterThan(0);
    expect(reboot.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = reboot.inputSchema.parse({ server_id: 1 }) as {
      wait: boolean;
    };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive server_id", () => {
    expect(() => reboot.inputSchema.parse({ server_id: -1 })).toThrow();
  });
});

describe("reboot — handler", () => {
  it("calls serverAction(id, 'reboot') and returns the slim shape", async () => {
    const ctx = makeCtx();
    const client = clientOf(ctx);
    const result = (await reboot.handler(
      reboot.inputSchema.parse({ server_id: 9 }),
      ctx,
    )) as Record<string, unknown>;
    expect(client.serverAction).toHaveBeenCalledWith(9, "reboot");
    expect(Object.keys(result).sort()).toEqual(OUTPUT_KEYS);
  });

  it("honors wait:false by returning the action without polling", async () => {
    const runningBody = {
      action: { ...sampleAction, status: "running", progress: 20 },
    };
    const ctx = makeCtx({
      serverAction: vi.fn().mockResolvedValue(runningBody),
    });
    const client = clientOf(ctx);
    const result = (await reboot.handler(
      reboot.inputSchema.parse({ server_id: 9, wait: false }),
      ctx,
    )) as { action: { status: string } };
    expect(client.waitForAction).not.toHaveBeenCalled();
    expect(result.action.status).toBe("running");
  });
});

// =============================================================================
// reset (confirm-gated hard reset)
// =============================================================================

describe("reset — metadata + schema", () => {
  it("has the expected name, a non-empty description, and a zod schema", () => {
    expect(reset.name).toBe("reset");
    expect(reset.description.length).toBeGreaterThan(0);
    expect(reset.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false and wait to true", () => {
    const parsed = reset.inputSchema.parse({ server_id: 1 }) as {
      confirm: boolean;
      wait: boolean;
    };
    expect(parsed.confirm).toBe(false);
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive server_id", () => {
    expect(() =>
      reset.inputSchema.parse({ server_id: 0, confirm: true }),
    ).toThrow();
  });
});

describe("reset — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const ctx = makeCtx();
    const client = clientOf(ctx);
    await expect(
      reset.handler(reset.inputSchema.parse({ server_id: 1 }), ctx),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.serverAction).not.toHaveBeenCalled();
  });

  it("preview names the real server and the hard-reset warning", async () => {
    const ctx = makeCtx();
    try {
      await reset.handler(reset.inputSchema.parse({ server_id: 1 }), ctx);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("web-01");
      expect(preview).toContain("id 1");
      expect(preview).toContain("HARD RESET");
    }
  });

  it("falls back to the id in the preview when the name is empty", async () => {
    const ctx = makeCtx({
      getServer: vi.fn().mockResolvedValue({ id: 5, name: "" }),
    });
    try {
      await reset.handler(reset.inputSchema.parse({ server_id: 5 }), ctx);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toContain("id 5");
    }
  });
});

describe("reset — past confirm gate", () => {
  it("with confirm:true calls serverAction(id, 'reset') and returns the slim shape", async () => {
    const ctx = makeCtx();
    const client = clientOf(ctx);
    const result = (await reset.handler(
      reset.inputSchema.parse({ server_id: 1, confirm: true }),
      ctx,
    )) as Record<string, unknown>;
    expect(client.serverAction).toHaveBeenCalledWith(1, "reset");
    expect(Object.keys(result).sort()).toEqual(OUTPUT_KEYS);
    expect(result.server_id).toBe(1);
    expect(result.action).toEqual({
      id: 42,
      command: "start_server",
      status: "success",
      progress: 100,
      finished: "2026-01-01T00:00:05Z",
    });
  });
});
