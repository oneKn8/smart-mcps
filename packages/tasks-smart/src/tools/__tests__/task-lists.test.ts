import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError } from "smart-mcp-core";
import {
  listTaskListsTool,
  getTaskListTool,
  createTaskListTool,
  updateTaskListTool,
  deleteTaskListTool,
} from "../task-lists.js";

function ctxWith(over: Record<string, unknown>) {
  return { client: over as unknown as never };
}

const listAlpha = {
  kind: "tasks#taskList",
  id: "list_alpha",
  etag: '"e"',
  title: "Groceries",
  updated: "2026-06-29T10:00:00.000Z",
  selfLink: "https://x",
};

describe("listTaskListsTool", () => {
  it("metadata within budget", () => {
    expect(listTaskListsTool.name).toBe("list_task_lists");
    expect(
      listTaskListsTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
    expect(listTaskListsTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("maps items via mapTaskList under task_lists, stripping extras", async () => {
    const listTaskLists = vi.fn().mockResolvedValue({ items: [listAlpha] });
    const out = await listTaskListsTool.handler({}, ctxWith({ listTaskLists }));
    expect(out).toEqual({
      task_lists: [
        {
          id: "list_alpha",
          title: "Groceries",
          updated: "2026-06-29T10:00:00.000Z",
        },
      ],
    });
  });

  it("returns an empty array when there are no lists", async () => {
    const listTaskLists = vi.fn().mockResolvedValue({ items: [] });
    const out = await listTaskListsTool.handler({}, ctxWith({ listTaskLists }));
    expect(out).toEqual({ task_lists: [] });
  });
});

describe("getTaskListTool", () => {
  it("requires task_list_id", () => {
    expect(() => getTaskListTool.inputSchema.parse({})).toThrow();
  });

  it("calls getTaskList and maps", async () => {
    const getTaskList = vi.fn().mockResolvedValue(listAlpha);
    const out = await getTaskListTool.handler(
      { task_list_id: "list_alpha" },
      ctxWith({ getTaskList }),
    );
    expect(getTaskList).toHaveBeenCalledWith("list_alpha");
    expect(out.task_list.id).toBe("list_alpha");
  });
});

describe("createTaskListTool", () => {
  it("requires a title", () => {
    expect(() => createTaskListTool.inputSchema.parse({})).toThrow();
  });

  it("inserts with { title } and maps the result", async () => {
    const insertTaskList = vi
      .fn()
      .mockResolvedValue({ id: "new", title: "Reading" });
    const out = await createTaskListTool.handler(
      { title: "Reading" },
      ctxWith({ insertTaskList }),
    );
    expect(insertTaskList).toHaveBeenCalledWith({ title: "Reading" });
    expect(out.task_list).toEqual({ id: "new", title: "Reading", updated: null });
  });
});

describe("updateTaskListTool", () => {
  it("patches title onto the named list", async () => {
    const patchTaskList = vi
      .fn()
      .mockResolvedValue({ id: "l1", title: "Renamed" });
    const out = await updateTaskListTool.handler(
      { task_list_id: "l1", title: "Renamed" },
      ctxWith({ patchTaskList }),
    );
    expect(patchTaskList).toHaveBeenCalledWith({
      tasklist: "l1",
      body: { title: "Renamed" },
    });
    expect(out.task_list.title).toBe("Renamed");
  });
});

describe("deleteTaskListTool — confirm gating", () => {
  it("throws ConfirmRequiredError with a preview naming the list, no delete call", async () => {
    const getTaskList = vi.fn().mockResolvedValue(listAlpha);
    const deleteTaskList = vi.fn();
    const parsed = deleteTaskListTool.inputSchema.parse({
      task_list_id: "list_alpha",
    }) as Parameters<typeof deleteTaskListTool.handler>[0];
    await expect(
      deleteTaskListTool.handler(parsed, ctxWith({ getTaskList, deleteTaskList })),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    try {
      await deleteTaskListTool.handler(
        parsed,
        ctxWith({ getTaskList, deleteTaskList }),
      );
    } catch (err) {
      expect((err as ConfirmRequiredError).preview).toContain("Groceries");
    }
    expect(deleteTaskList).not.toHaveBeenCalled();
  });

  it("deletes when confirm: true", async () => {
    const getTaskList = vi.fn().mockResolvedValue(listAlpha);
    const deleteTaskList = vi.fn().mockResolvedValue(undefined);
    const parsed = deleteTaskListTool.inputSchema.parse({
      task_list_id: "list_alpha",
      confirm: true,
    }) as Parameters<typeof deleteTaskListTool.handler>[0];
    const out = await deleteTaskListTool.handler(
      parsed,
      ctxWith({ getTaskList, deleteTaskList }),
    );
    expect(deleteTaskList).toHaveBeenCalledWith({ tasklist: "list_alpha" });
    expect(out).toEqual({ deleted: true });
  });

  it("falls back to the id in the preview when the lookup fails", async () => {
    const getTaskList = vi.fn().mockRejectedValue(new Error("boom"));
    const deleteTaskList = vi.fn();
    const parsed = deleteTaskListTool.inputSchema.parse({
      task_list_id: "list_xyz",
    }) as Parameters<typeof deleteTaskListTool.handler>[0];
    try {
      await deleteTaskListTool.handler(
        parsed,
        ctxWith({ getTaskList, deleteTaskList }),
      );
    } catch (err) {
      expect((err as ConfirmRequiredError).preview).toContain("list_xyz");
    }
  });
});
