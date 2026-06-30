import { describe, it, expect } from "vitest";
import { FlowProgress, FlowStepError, reasonOf } from "../flow-error.js";

describe("FlowProgress", () => {
  it("returns step values on success and records progress", async () => {
    const p = new FlowProgress();
    const a = await p.run("step_a", async () => 1);
    p.note("did a");
    const b = await p.run("step_b", async () => a + 1);
    expect(b).toBe(2);
    expect(p.done()).toEqual(["did a"]);
  });

  it("wraps a thrown step into a FlowStepError carrying prior progress", async () => {
    const p = new FlowProgress();
    await p.run("read", async () => "ok");
    p.note("read item X");
    const err = await p
      .run("write", async () => {
        throw new Error("upstream 500");
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(FlowStepError);
    expect(err.step).toBe("write");
    expect(err.reason).toBe("upstream 500");
    expect(err.completed).toEqual(["read item X"]);
    expect(err.message).toContain("read item X");
    expect(err.message).toContain('Step "write" failed: upstream 500');
  });

  it("does not double-wrap an already-FlowStepError", async () => {
    const p = new FlowProgress();
    const inner = new FlowStepError("inner", "boom", ["x"], new Error("boom"));
    const err = await p
      .run("outer", async () => {
        throw inner;
      })
      .catch((e) => e);
    expect(err).toBe(inner);
  });

  it("reasonOf lifts a message from any throwable", () => {
    expect(reasonOf(new Error("nope"))).toBe("nope");
    expect(reasonOf("bare string")).toBe("bare string");
  });
});
