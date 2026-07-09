import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { NotFoundError } from "smart-mcp-core";
import { getAction, waitForAction } from "../actions.js";

// A full raw HetznerAction with the fields `summarizeAction` must strip
// (started / resources / error) so field-strip assertions have something to bite.
const sampleAction = {
  id: 42,
  command: "start_server",
  status: "success",
  progress: 100,
  started: "2026-07-08T00:00:00Z",
  finished: "2026-07-08T00:01:00Z",
  resources: [{ id: 5, type: "server" }],
  error: null,
};

// The slim ActionSummary keys returned to the caller.
const SUMMARY_KEYS = ["id", "command", "status", "progress", "finished"].sort();

type FakeActionClient = {
  getAction: ReturnType<typeof vi.fn>;
  waitForAction: ReturnType<typeof vi.fn>;
};

function makeClient(
  overrides: Partial<FakeActionClient> = {},
): FakeActionClient {
  return {
    getAction: vi.fn().mockResolvedValue(sampleAction),
    waitForAction: vi.fn().mockResolvedValue(sampleAction),
    ...overrides,
  };
}

function makeCtx(client: FakeActionClient) {
  return { client: client as unknown as never };
}

// =============================================================================
// get_action
// =============================================================================

describe("getAction — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(getAction.name).toBe("get_action");
    expect(getAction.description).toBe("Get an action by ID.");
    expect(getAction.description.length).toBeGreaterThan(0);
    expect(getAction.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects a missing action_id", () => {
    expect(() => getAction.inputSchema.parse({})).toThrow();
  });

  it("rejects a non-positive action_id", () => {
    expect(() => getAction.inputSchema.parse({ action_id: 0 })).toThrow();
    expect(() => getAction.inputSchema.parse({ action_id: -3 })).toThrow();
  });

  it("rejects a non-integer action_id", () => {
    expect(() => getAction.inputSchema.parse({ action_id: 1.5 })).toThrow();
  });

  it("accepts a positive integer action_id", () => {
    expect(() => getAction.inputSchema.parse({ action_id: 42 })).not.toThrow();
  });
});

describe("getAction — handler", () => {
  it("calls client.getAction with the input id exactly once", async () => {
    const client = makeClient();
    await getAction.handler(
      getAction.inputSchema.parse({ action_id: 42 }),
      makeCtx(client),
    );
    expect(client.getAction).toHaveBeenCalledTimes(1);
    expect(client.getAction).toHaveBeenCalledWith(42);
  });

  it("returns the slim ActionSummary shape only (strips extras)", async () => {
    const client = makeClient();
    const result = (await getAction.handler(
      getAction.inputSchema.parse({ action_id: 42 }),
      makeCtx(client),
    )) as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual(SUMMARY_KEYS);
    expect(result).toEqual({
      id: 42,
      command: "start_server",
      status: "success",
      progress: 100,
      finished: "2026-07-08T00:01:00Z",
    });
    expect(result).not.toHaveProperty("started");
    expect(result).not.toHaveProperty("resources");
    expect(result).not.toHaveProperty("error");
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      getAction: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Action not found: 999")),
    });
    await expect(
      getAction.handler(
        getAction.inputSchema.parse({ action_id: 999 }),
        makeCtx(client),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// wait_for_action
// =============================================================================

describe("waitForAction — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(waitForAction.name).toBe("wait_for_action");
    expect(waitForAction.description).toBe("Poll an action until it settles.");
    expect(waitForAction.description.length).toBeGreaterThan(0);
    expect(waitForAction.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults timeout_seconds to 120 when omitted", () => {
    const parsed = waitForAction.inputSchema.parse({ action_id: 7 }) as {
      timeout_seconds: number;
    };
    expect(parsed.timeout_seconds).toBe(120);
  });

  it("rejects a missing action_id", () => {
    expect(() => waitForAction.inputSchema.parse({})).toThrow();
  });

  it("rejects a non-positive timeout_seconds", () => {
    expect(() =>
      waitForAction.inputSchema.parse({ action_id: 7, timeout_seconds: 0 }),
    ).toThrow();
  });

  it("rejects a non-integer timeout_seconds", () => {
    expect(() =>
      waitForAction.inputSchema.parse({ action_id: 7, timeout_seconds: 1.5 }),
    ).toThrow();
  });
});

describe("waitForAction — handler", () => {
  it("calls client.waitForAction with id and default timeoutMs (120s -> 120000ms)", async () => {
    const client = makeClient();
    await waitForAction.handler(
      waitForAction.inputSchema.parse({ action_id: 7 }),
      makeCtx(client),
    );
    expect(client.waitForAction).toHaveBeenCalledTimes(1);
    expect(client.waitForAction).toHaveBeenCalledWith(7, { timeoutMs: 120000 });
  });

  it("converts a custom timeout_seconds to milliseconds", async () => {
    const client = makeClient();
    await waitForAction.handler(
      waitForAction.inputSchema.parse({ action_id: 7, timeout_seconds: 5 }),
      makeCtx(client),
    );
    expect(client.waitForAction).toHaveBeenCalledWith(7, { timeoutMs: 5000 });
  });

  it("returns the slim ActionSummary shape only (strips extras)", async () => {
    const client = makeClient();
    const result = (await waitForAction.handler(
      waitForAction.inputSchema.parse({ action_id: 7 }),
      makeCtx(client),
    )) as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual(SUMMARY_KEYS);
    expect(result).toEqual({
      id: 42,
      command: "start_server",
      status: "success",
      progress: 100,
      finished: "2026-07-08T00:01:00Z",
    });
    expect(result).not.toHaveProperty("started");
    expect(result).not.toHaveProperty("resources");
    expect(result).not.toHaveProperty("error");
  });

  it("propagates upstream errors (timeout/failed action) from the client", async () => {
    const client = makeClient({
      waitForAction: vi
        .fn()
        .mockRejectedValue(new Error("Hetzner action 7 did not finish")),
    });
    await expect(
      waitForAction.handler(
        waitForAction.inputSchema.parse({ action_id: 7 }),
        makeCtx(client),
      ),
    ).rejects.toThrow(/did not finish/);
  });
});
