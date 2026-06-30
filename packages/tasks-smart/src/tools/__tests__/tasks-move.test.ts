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
  it("rejects moving a recurring task across lists, without calling move", async () => {
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
