import { describe, it, expect, vi } from "vitest";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import { runFunctionTool } from "../run.js";

type FakeClient = { runFunction: ReturnType<typeof vi.fn> };

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return { runFunction: vi.fn(), ...over };
}

// Default account the context resolves to when a call omits `account`.
const ACCT = "acct";

function ctxOf(client: FakeClient): { client: never; defaultAccount: string } {
  return { client: client as unknown as never, defaultAccount: ACCT };
}

function parse(raw: unknown): Parameters<typeof runFunctionTool.handler>[0] {
  return runFunctionTool.inputSchema.parse(
    raw,
  ) as Parameters<typeof runFunctionTool.handler>[0];
}

describe("runFunctionTool — metadata", () => {
  it("name + description budget", () => {
    expect(runFunctionTool.name).toBe("run_function");
    expect(
      runFunctionTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });
});

describe("runFunctionTool — gating (confirm required)", () => {
  it("throws ConfirmRequiredError when confirm omitted; NO execution happens", async () => {
    const client = makeClient();
    await expect(
      runFunctionTool.handler(
        parse({ deployment_id: "dep_1", function: "doThing" }),
        ctxOf(client),
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.runFunction).not.toHaveBeenCalled();
  });

  it("preview shows the exact target (deploymentId), function, parameters, devMode", async () => {
    const client = makeClient();
    try {
      await runFunctionTool.handler(
        parse({
          deployment_id: "dep_1",
          function: "doThing",
          parameters: ["a", 1, true],
          dev_mode: true,
        }),
        ctxOf(client),
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const e = err as ConfirmRequiredError;
      expect(e.preview).toContain("account: acct");
      expect(e.preview).toContain("deploymentId: dep_1");
      expect(e.preview).toContain("function: doThing");
      expect(e.preview).toContain('["a",1,true]');
      expect(e.preview).toContain("devMode: true");
      expect(e.preview.toLowerCase()).toContain("remote code execution");
    }
  });

  it("preview labels the target as scriptId when only script_id is given", async () => {
    // Guard against a vacuous pass: if the confirm gate ever regresses the
    // handler returns normally, the catch never runs, and this test would pass
    // with zero assertions. expect.assertions(1) forces it to fail loud.
    expect.assertions(1);
    const client = makeClient();
    try {
      await runFunctionTool.handler(
        parse({ script_id: "s1", function: "f" }),
        ctxOf(client),
      );
    } catch (err) {
      expect((err as ConfirmRequiredError).preview).toContain("scriptId: s1");
    }
  });
});

describe("runFunctionTool — validation", () => {
  it("throws ValidationError when neither deployment_id nor script_id is set", async () => {
    const client = makeClient();
    await expect(
      runFunctionTool.handler(
        parse({ function: "f", confirm: true }),
        ctxOf(client),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.runFunction).not.toHaveBeenCalled();
  });
});

describe("runFunctionTool — execution (confirmed)", () => {
  it("prefers deployment_id and passes function/parameters/devMode through", async () => {
    const client = makeClient({
      runFunction: vi.fn().mockResolvedValue({ done: true, result: { ok: 1 } }),
    });
    const out = await runFunctionTool.handler(
      parse({
        deployment_id: "dep_1",
        script_id: "s1",
        function: "doThing",
        parameters: ["x"],
        confirm: true,
      }),
      ctxOf(client),
    );
    // deployment_id wins over script_id for the target id.
    expect(client.runFunction).toHaveBeenCalledWith(ACCT, {
      id: "dep_1",
      functionName: "doThing",
      parameters: ["x"],
      devMode: false,
    });
    expect(out).toEqual({ done: true, result: { ok: 1 } });
  });

  it("defaults parameters to [] and devMode to false", async () => {
    const client = makeClient({
      runFunction: vi.fn().mockResolvedValue({ done: true, result: null }),
    });
    await runFunctionTool.handler(
      parse({ script_id: "s1", function: "f", confirm: true }),
      ctxOf(client),
    );
    expect(client.runFunction).toHaveBeenCalledWith(ACCT, {
      id: "s1",
      functionName: "f",
      parameters: [],
      devMode: false,
    });
  });
});
