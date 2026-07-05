import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { accountSummary } from "../account.js";

type FakeClient = {
  getBalance: ReturnType<typeof vi.fn>;
  listPods: ReturnType<typeof vi.fn>;
};

function makeClient(
  balance: Record<string, unknown>,
  runningPods: Array<Record<string, unknown>> = [],
): FakeClient {
  return {
    getBalance: vi.fn().mockResolvedValue(balance),
    listPods: vi.fn().mockResolvedValue({ pods: runningPods }),
  };
}

async function run(client: FakeClient): Promise<Record<string, unknown>> {
  return (await accountSummary.handler(
    accountSummary.inputSchema.parse({}) as Record<string, never>,
    { client: client as unknown as never },
  )) as Record<string, unknown>;
}

describe("accountSummary — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(accountSummary.name).toBe("account_summary");
    expect(accountSummary.description).toBe(
      "Account balance, burn rate, and runway.",
    );
    expect(accountSummary.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => accountSummary.inputSchema.parse({})).not.toThrow();
  });
});

describe("accountSummary — data sources", () => {
  it("queries balance once and lists only RUNNING pods", async () => {
    const client = makeClient({
      clientBalance: 100,
      currentSpendPerHr: 0.5,
      spendLimit: 500,
      minBalance: 10,
    });
    await run(client);
    expect(client.getBalance).toHaveBeenCalledTimes(1);
    expect(client.getBalance).toHaveBeenCalledWith();
    expect(client.listPods).toHaveBeenCalledTimes(1);
    expect(client.listPods).toHaveBeenCalledWith({ desiredStatus: "RUNNING" });
  });
});

describe("accountSummary — output shape", () => {
  it("returns exactly the 7 documented keys", async () => {
    const client = makeClient({
      clientBalance: 100,
      currentSpendPerHr: 0.5,
      spendLimit: 500,
      minBalance: 10,
    });
    const result = await run(client);
    expect(Object.keys(result).sort()).toEqual(
      [
        "active_pod_count",
        "balance_usd",
        "min_balance",
        "notes",
        "runway_hours",
        "spend_limit",
        "spend_per_hr",
      ].sort(),
    );
  });

  it("maps balance fields straight through", async () => {
    const client = makeClient({
      clientBalance: 250,
      currentSpendPerHr: 2,
      spendLimit: 1000,
      minBalance: 25,
    });
    const result = await run(client);
    expect(result.balance_usd).toBe(250);
    expect(result.spend_per_hr).toBe(2);
    expect(result.spend_limit).toBe(1000);
    expect(result.min_balance).toBe(25);
  });
});

describe("accountSummary — runway math", () => {
  it("computes runway_hours = balance / spend_per_hr rounded to 1 decimal", async () => {
    // 100 / 3 = 33.333... -> 33.3
    const client = makeClient({ clientBalance: 100, currentSpendPerHr: 3 });
    const result = await run(client);
    expect(result.runway_hours).toBe(33.3);
  });

  it("runway_hours is null when spend_per_hr is 0", async () => {
    const client = makeClient({ clientBalance: 100, currentSpendPerHr: 0 });
    const result = await run(client);
    expect(result.runway_hours).toBeNull();
  });

  it("runway_hours is null when spend_per_hr is absent", async () => {
    const client = makeClient({ clientBalance: 100 });
    const result = await run(client);
    expect(result.runway_hours).toBeNull();
  });

  it("runway_hours is null when balance is absent even if burning", async () => {
    const client = makeClient({ currentSpendPerHr: 1 });
    const result = await run(client);
    expect(result.runway_hours).toBeNull();
  });
});

describe("accountSummary — active pod count", () => {
  it("counts RUNNING pods returned by the client", async () => {
    const client = makeClient({ clientBalance: 100, currentSpendPerHr: 1 }, [
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
    const result = await run(client);
    expect(result.active_pod_count).toBe(3);
  });

  it("is 0 when there are no running pods", async () => {
    const client = makeClient({ clientBalance: 100, currentSpendPerHr: 1 }, []);
    const result = await run(client);
    expect(result.active_pod_count).toBe(0);
  });
});

describe("accountSummary — null safety", () => {
  it("nulls every balance field when upstream returns an empty object", async () => {
    const client = makeClient({});
    const result = await run(client);
    expect(result.balance_usd).toBeNull();
    expect(result.spend_per_hr).toBeNull();
    expect(result.spend_limit).toBeNull();
    expect(result.min_balance).toBeNull();
    expect(result.runway_hours).toBeNull();
    expect(result.active_pod_count).toBe(0);
    expect(result.notes).toEqual([]);
  });

  it("coerces non-numeric upstream values to null", async () => {
    const client = makeClient({
      clientBalance: "oops",
      currentSpendPerHr: null,
      spendLimit: undefined,
      minBalance: {},
    });
    const result = await run(client);
    expect(result.balance_usd).toBeNull();
    expect(result.spend_per_hr).toBeNull();
    expect(result.spend_limit).toBeNull();
    expect(result.min_balance).toBeNull();
  });
});

describe("accountSummary — notes / warnings", () => {
  it("warns when runway is under 24h and echoes the rounded value", async () => {
    // 10 / 1 = 10h runway (< 24)
    const client = makeClient({ clientBalance: 10, currentSpendPerHr: 1 });
    const result = await run(client);
    const notes = result.notes as string[];
    expect(notes.some((n) => /low runway/i.test(n))).toBe(true);
    expect(notes.some((n) => n.includes("10h"))).toBe(true);
  });

  it("does not warn about runway when it is >= 24h", async () => {
    // 100 / 1 = 100h runway
    const client = makeClient({ clientBalance: 100, currentSpendPerHr: 1 });
    const result = await run(client);
    const notes = result.notes as string[];
    expect(notes.some((n) => /low runway/i.test(n))).toBe(false);
  });

  it("warns when balance is at or below the minimum balance", async () => {
    const client = makeClient({
      clientBalance: 5,
      currentSpendPerHr: 0,
      minBalance: 10,
    });
    const result = await run(client);
    const notes = result.notes as string[];
    expect(notes.some((n) => /minimum/i.test(n))).toBe(true);
  });

  it("warns when balance exactly equals the minimum balance", async () => {
    const client = makeClient({
      clientBalance: 10,
      currentSpendPerHr: 0,
      minBalance: 10,
    });
    const result = await run(client);
    const notes = result.notes as string[];
    expect(notes.some((n) => /minimum/i.test(n))).toBe(true);
  });

  it("does not warn about minimum when balance is safely above it", async () => {
    const client = makeClient({
      clientBalance: 100,
      currentSpendPerHr: 0,
      minBalance: 10,
    });
    const result = await run(client);
    const notes = result.notes as string[];
    expect(notes.some((n) => /minimum/i.test(n))).toBe(false);
  });

  it("can emit both a runway and a minimum-balance warning together", async () => {
    // 5 / 1 = 5h runway (< 24) AND balance 5 <= min 10
    const client = makeClient({
      clientBalance: 5,
      currentSpendPerHr: 1,
      minBalance: 10,
    });
    const result = await run(client);
    const notes = result.notes as string[];
    expect(notes.some((n) => /low runway/i.test(n))).toBe(true);
    expect(notes.some((n) => /minimum/i.test(n))).toBe(true);
    expect(notes).toHaveLength(2);
  });
});
