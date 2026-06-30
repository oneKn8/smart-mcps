import { describe, it, expect, vi } from "vitest";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import { moveTaskTool, clearCompletedTool } from "../tasks-move.js";

function ctxWith(over: Record<string, unknown>) {
  return { client: over as unknown as never };
}

describe("moveTaskTool — happy paths", () => {
  it("a pure reorder (previous only) does NOT pre-fetch any task", async () => {
    const getTask = vi.fn();
    const moveTask = vi.fn().mockResolvedValue({ id: "t1" });
    await moveTaskTool.handler(
      { task_list_id: "l1", task_id: "t1", previous: "s1" },
      ctxWith({ getTask, moveTask }),
    );
    expect(getTask).not.toHaveBeenCalled();
    expect(moveTask).toHaveBeenCalledWith({
      tasklist: "l1",
      task: "t1",
      previous: "s1",
    });
  });

  it("nesting under a plain parent validates both tasks then moves", async () => {
    const getTask = vi
      .fn()
      .mockResolvedValueOnce({ id: "t1", title: "child" }) // moving task
      .mockResolvedValueOnce({ id: "p1", title: "parent" }); // parent task
    const moveTask = vi.fn().mockResolvedValue({ id: "t1", parent: "p1" });
    const out = await moveTaskTool.handler(
      { task_list_id: "l1", task_id: "t1", parent: "p1" },
      ctxWith({ getTask, moveTask }),
    );
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(moveTask).toHaveBeenCalledWith({
      tasklist: "l1",
      task: "t1",
      parent: "p1",
    });
    expect(out.task.parent).toBe("p1");
  });

  it("cross-list move of a non-recurring task succeeds", async () => {
    const getTask = vi.fn().mockResolvedValue({ id: "t1", title: "x" });
    const moveTask = vi.fn().mockResolvedValue({ id: "t1" });
    await moveTaskTool.handler(
      { task_list_id: "l1", task_id: "t1", destination_task_list_id: "l2" },
      ctxWith({ getTask, moveTask }),
    );
    expect(moveTask).toHaveBeenCalledWith({
      tasklist: "l1",
      task: "t1",
      destinationTasklist: "l2",
    });
  });
});

describe("moveTaskTool — documented-impossible moves are rejected", () => {
  // SYNTHETIC SHAPE — NOT the live API. The public Google `Task` schema does
  // NOT expose `recurrence` / `recurringTaskId`, so a real recurring task does
  // not carry this field and the pre-check below would NOT fire against it (see
  // the honest "best-effort pre-check is bypassed" test). This test injects an
  // off-schema `recurrence` array purely to exercise the rejection BRANCH; it
  // does not imply the pre-check catches real recurring tasks. The API's own
  // 400 is the real backstop for those.
  it("rejects a cross-list move when the (synthetic) recurrence field is visible", async () => {
    const getTask = vi
      .fn()
      .mockResolvedValue({ id: "t1", recurrence: ["RRULE:FREQ=DAILY"] });
    const moveTask = vi.fn();
    await expect(
      moveTaskTool.handler(
        { task_list_id: "l1", task_id: "t1", destination_task_list_id: "l2" },
        ctxWith({ getTask, moveTask }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("best-effort pre-check is bypassed when recurrence is invisible (API 400 is the backstop)", async () => {
    // The realistic production case: a recurring task whose recurrence is NOT
    // exposed by the public schema. The local pre-check cannot see it, so the
    // move IS attempted and the API 400 (not this code) is what rejects it.
    // This documents the real coverage so the suite implies no false confidence.
    const getTask = vi
      .fn()
      .mockResolvedValue({ id: "t1", title: "daily standup" });
    const moveTask = vi.fn().mockResolvedValue({ id: "t1" });
    await moveTaskTool.handler(
      { task_list_id: "l1", task_id: "t1", destination_task_list_id: "l2" },
      ctxWith({ getTask, moveTask }),
    );
    expect(moveTask).toHaveBeenCalledWith({
      tasklist: "l1",
      task: "t1",
      destinationTasklist: "l2",
    });
  });

  it("rejects nesting an assigned task as a subtask", async () => {
    const getTask = vi.fn().mockResolvedValue({
      id: "t1",
      assignmentInfo: { surfaceType: "DOCUMENT" },
    });
    const moveTask = vi.fn();
    await expect(
      moveTaskTool.handler(
        { task_list_id: "l1", task_id: "t1", parent: "p1" },
        ctxWith({ getTask, moveTask }),
      ),
    ).rejects.toThrow(/assigned/);
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("rejects using an assigned task as a parent", async () => {
    const getTask = vi
      .fn()
      .mockResolvedValueOnce({ id: "t1", title: "child" }) // moving task ok
      .mockResolvedValueOnce({
        id: "p1",
        assignmentInfo: { surfaceType: "SPACE" },
      }); // parent assigned
    const moveTask = vi.fn();
    await expect(
      moveTaskTool.handler(
        { task_list_id: "l1", task_id: "t1", parent: "p1" },
        ctxWith({ getTask, moveTask }),
      ),
    ).rejects.toThrow(/parent/i);
    expect(moveTask).not.toHaveBeenCalled();
  });
});

describe("clearCompletedTool — hide, not delete", () => {
  it("description says hide and never delete", () => {
    expect(clearCompletedTool.description.toLowerCase()).toContain("hide");
    expect(clearCompletedTool.description.toLowerCase()).not.toContain(
      "delete",
    );
  });

  it("blocks without confirm; preview explains tasks are hidden not deleted", async () => {
    const clearTasks = vi.fn();
    const parsed = clearCompletedTool.inputSchema.parse({
      task_list_id: "l1",
    }) as Parameters<typeof clearCompletedTool.handler>[0];
    try {
      await clearCompletedTool.handler(parsed, ctxWith({ clearTasks }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toMatch(/not deleted/i);
    }
    expect(clearTasks).not.toHaveBeenCalled();
  });

  it("clears with confirm: true", async () => {
    const clearTasks = vi.fn().mockResolvedValue(undefined);
    const parsed = clearCompletedTool.inputSchema.parse({
      task_list_id: "l1",
      confirm: true,
    }) as Parameters<typeof clearCompletedTool.handler>[0];
    const out = await clearCompletedTool.handler(parsed, ctxWith({ clearTasks }));
    expect(clearTasks).toHaveBeenCalledWith({ tasklist: "l1" });
    expect(out).toEqual({ cleared: true });
  });
});
