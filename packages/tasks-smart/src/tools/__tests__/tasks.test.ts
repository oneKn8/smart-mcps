import { describe, it, expect, vi } from "vitest";
import { ConfirmRequiredError } from "smart-mcp-core";
import {
  listTasksTool,
  getTaskTool,
  createTaskTool,
  updateTaskTool,
  completeTaskTool,
  deleteTaskTool,
} from "../tasks.js";

function ctxWith(over: Record<string, unknown>) {
  return { client: over as unknown as never };
}

const rawTask = {
  kind: "tasks#task",
  id: "t1",
  etag: '"e"',
  title: "Buy milk",
  position: "0001",
  status: "needsAction",
  due: "2026-06-30T00:00:00.000Z",
  selfLink: "https://x",
};

describe("listTasksTool", () => {
  it("applies safe defaults on an empty-but-list-id input", () => {
    const parsed = listTasksTool.inputSchema.parse({ task_list_id: "l1" }) as {
      show_completed: boolean;
      show_hidden: boolean;
      show_deleted: boolean;
      show_assigned: boolean;
    };
    expect(parsed.show_completed).toBe(true);
    expect(parsed.show_hidden).toBe(false);
    expect(parsed.show_deleted).toBe(false);
    expect(parsed.show_assigned).toBe(false);
  });

  it("forwards filters to the client and maps + paginates", async () => {
    const listTasks = vi
      .fn()
      .mockResolvedValue({ items: [rawTask], nextPageToken: "next" });
    const parsed = listTasksTool.inputSchema.parse({
      task_list_id: "l1",
      show_completed: false,
      due_max: "2026-07-01T00:00:00.000Z",
      max_results: 25,
    }) as Parameters<typeof listTasksTool.handler>[0];
    const out = await listTasksTool.handler(parsed, ctxWith({ listTasks }));
    expect(listTasks).toHaveBeenCalledWith({
      tasklist: "l1",
      showCompleted: false,
      showHidden: false,
      showDeleted: false,
      showAssigned: false,
      dueMax: "2026-07-01T00:00:00.000Z",
      maxResults: 25,
    });
    expect(out.tasks[0]?.due).toBe("2026-06-30");
    expect(out.next_page_token).toBe("next");
  });

  it("omits next_page_token when the client returns none", async () => {
    const listTasks = vi.fn().mockResolvedValue({ items: [] });
    const parsed = listTasksTool.inputSchema.parse({
      task_list_id: "l1",
    }) as Parameters<typeof listTasksTool.handler>[0];
    const out = await listTasksTool.handler(parsed, ctxWith({ listTasks }));
    expect(out).toEqual({ tasks: [] });
  });
});

describe("getTaskTool", () => {
  it("requires both ids", () => {
    expect(() => getTaskTool.inputSchema.parse({ task_list_id: "l1" })).toThrow();
  });

  it("fetches and maps", async () => {
    const getTask = vi.fn().mockResolvedValue(rawTask);
    const out = await getTaskTool.handler(
      { task_list_id: "l1", task_id: "t1" },
      ctxWith({ getTask }),
    );
    expect(getTask).toHaveBeenCalledWith({ tasklist: "l1", task: "t1" });
    expect(out.task.id).toBe("t1");
  });
});

describe("createTaskTool", () => {
  it("builds the body and expands a date-only due to UTC midnight", async () => {
    const insertTask = vi.fn().mockResolvedValue(rawTask);
    await createTaskTool.handler(
      {
        task_list_id: "l1",
        title: "Buy milk",
        notes: "2%",
        due: "2026-06-30",
        parent: "p1",
      },
      ctxWith({ insertTask }),
    );
    expect(insertTask).toHaveBeenCalledWith({
      tasklist: "l1",
      body: { title: "Buy milk", notes: "2%", due: "2026-06-30T00:00:00.000Z" },
      parent: "p1",
    });
  });

  it("omits due when not provided", async () => {
    const insertTask = vi.fn().mockResolvedValue(rawTask);
    await createTaskTool.handler(
      { task_list_id: "l1", title: "Just a title" },
      ctxWith({ insertTask }),
    );
    expect(insertTask).toHaveBeenCalledWith({
      tasklist: "l1",
      body: { title: "Just a title" },
    });
  });
});

describe("updateTaskTool", () => {
  it("patches only the provided fields", async () => {
    const patchTask = vi.fn().mockResolvedValue(rawTask);
    await updateTaskTool.handler(
      { task_list_id: "l1", task_id: "t1", title: "New", due: "2026-07-04" },
      ctxWith({ patchTask }),
    );
    expect(patchTask).toHaveBeenCalledWith({
      tasklist: "l1",
      task: "t1",
      body: { title: "New", due: "2026-07-04T00:00:00.000Z" },
    });
  });
});

describe("completeTaskTool", () => {
  it("marks complete by default", async () => {
    const patchTask = vi
      .fn()
      .mockResolvedValue({ ...rawTask, status: "completed" });
    const parsed = completeTaskTool.inputSchema.parse({
      task_list_id: "l1",
      task_id: "t1",
    }) as Parameters<typeof completeTaskTool.handler>[0];
    const out = await completeTaskTool.handler(parsed, ctxWith({ patchTask }));
    expect(patchTask).toHaveBeenCalledWith({
      tasklist: "l1",
      task: "t1",
      body: { status: "completed" },
    });
    expect(out.task.status).toBe("completed");
  });

  it("reopens with completed: false (clears the timestamp)", async () => {
    const patchTask = vi.fn().mockResolvedValue(rawTask);
    const parsed = completeTaskTool.inputSchema.parse({
      task_list_id: "l1",
      task_id: "t1",
      completed: false,
    }) as Parameters<typeof completeTaskTool.handler>[0];
    await completeTaskTool.handler(parsed, ctxWith({ patchTask }));
    expect(patchTask).toHaveBeenCalledWith({
      tasklist: "l1",
      task: "t1",
      body: { status: "needsAction", completed: null },
    });
  });
});

describe("deleteTaskTool — confirm gating", () => {
  it("blocks without confirm and names the task in the preview", async () => {
    const getTask = vi.fn().mockResolvedValue(rawTask);
    const deleteTask = vi.fn();
    const parsed = deleteTaskTool.inputSchema.parse({
      task_list_id: "l1",
      task_id: "t1",
    }) as Parameters<typeof deleteTaskTool.handler>[0];
    try {
      await deleteTaskTool.handler(parsed, ctxWith({ getTask, deleteTask }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toContain("Buy milk");
    }
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("deletes with confirm: true", async () => {
    const getTask = vi.fn().mockResolvedValue(rawTask);
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    const parsed = deleteTaskTool.inputSchema.parse({
      task_list_id: "l1",
      task_id: "t1",
      confirm: true,
    }) as Parameters<typeof deleteTaskTool.handler>[0];
    const out = await deleteTaskTool.handler(
      parsed,
      ctxWith({ getTask, deleteTask }),
    );
    expect(deleteTask).toHaveBeenCalledWith({ tasklist: "l1", task: "t1" });
    expect(out).toEqual({ deleted: true });
  });
});
