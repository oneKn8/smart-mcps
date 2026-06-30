import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ValidationError } from "smart-mcp-core";
import { todayTasksTool, overdueTasksTool, quickAddTool } from "../shortcuts.js";

function ctxWith(over: Record<string, unknown>) {
  return { client: over as unknown as never };
}

// The instant 2026-06-30T20:00:00Z is June 30 in UTC but ALREADY July 1 in
// Asia/Dhaka (UTC+6). Pinning the host zone to Dhaka proves the shortcuts
// bucket against the user's LOCAL calendar date, not the UTC date — the
// date-only `due` trap the reference warns about.
const EDGE = new Date("2026-06-30T20:00:00.000Z");

let savedTz: string | undefined;

beforeEach(() => {
  savedTz = process.env.TZ;
  process.env.TZ = "Asia/Dhaka";
  vi.useFakeTimers();
  vi.setSystemTime(EDGE);
});

afterEach(() => {
  vi.useRealTimers();
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

// Raw Google tasks (due stored at UTC midnight of the user's chosen date).
const dueJun30 = { id: "t_jun30", title: "yesterday", due: "2026-06-30T00:00:00.000Z" };
const dueJul01 = { id: "t_jul01", title: "today", due: "2026-07-01T00:00:00.000Z" };
const dueJul02 = { id: "t_jul02", title: "tomorrow", due: "2026-07-02T00:00:00.000Z" };
const noDue = { id: "t_none", title: "someday" };
const completedToday = {
  id: "t_done",
  title: "done",
  status: "completed",
  due: "2026-07-01T00:00:00.000Z",
  completed: "2026-07-01T09:00:00.000Z",
};

describe("todayTasksTool — local-date bucketing", () => {
  it("returns only incomplete tasks whose LOCAL due date is today (Jul 1)", async () => {
    const listTasks = vi.fn().mockResolvedValue({
      items: [dueJun30, dueJul01, dueJul02, noDue, completedToday],
    });
    const out = await todayTasksTool.handler(
      { task_list_id: "l1" },
      ctxWith({ listTasks }),
    );
    expect(out.date).toBe("2026-07-01");
    expect(out.tasks.map((e) => e.task.id)).toEqual(["t_jul01"]);
    expect(out.tasks[0]).toEqual({
      task_list_id: "l1",
      task: {
        id: "t_jul01",
        title: "today",
        notes: null,
        status: "needsAction",
        due: "2026-07-01",
        completed: null,
        parent: null,
        deleted: false,
        hidden: false,
        web_view_link: null,
      },
    });
  });

  it("passes a today-window dueMin/dueMax trim hint and showCompleted=false", async () => {
    const listTasks = vi.fn().mockResolvedValue({ items: [] });
    await todayTasksTool.handler({ task_list_id: "l1" }, ctxWith({ listTasks }));
    expect(listTasks).toHaveBeenCalledWith({
      tasklist: "l1",
      showCompleted: false,
      dueMin: "2026-07-01T00:00:00.000Z",
      dueMax: "2026-07-02T00:00:00.000Z",
    });
  });

  it("scans every list when no task_list_id is given, tagging each task", async () => {
    const listTaskLists = vi
      .fn()
      .mockResolvedValue({ items: [{ id: "l1" }, { id: "l2" }] });
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce({ items: [dueJul01] })
      .mockResolvedValueOnce({ items: [{ ...dueJul01, id: "t_l2" }] });
    const out = await todayTasksTool.handler(
      {},
      ctxWith({ listTaskLists, listTasks }),
    );
    expect(listTaskLists).toHaveBeenCalledTimes(1);
    expect(out.tasks).toHaveLength(2);
    expect(out.tasks.map((e) => e.task_list_id)).toEqual(["l1", "l2"]);
  });
});

describe("overdueTasksTool — local-date bucketing", () => {
  it("returns incomplete tasks whose due date is strictly before today", async () => {
    const listTasks = vi.fn().mockResolvedValue({
      items: [dueJun30, dueJul01, dueJul02, noDue, completedToday],
    });
    const out = await overdueTasksTool.handler(
      { task_list_id: "l1" },
      ctxWith({ listTasks }),
    );
    expect(out.date).toBe("2026-07-01");
    // Jun 30 < Jul 1 => overdue. Jul 1 is today (not overdue). No-due excluded.
    expect(out.tasks.map((e) => e.task.id)).toEqual(["t_jun30"]);
  });

  it("passes a dueMax=today trim hint and showCompleted=false", async () => {
    const listTasks = vi.fn().mockResolvedValue({ items: [] });
    await overdueTasksTool.handler(
      { task_list_id: "l1" },
      ctxWith({ listTasks }),
    );
    expect(listTasks).toHaveBeenCalledWith({
      tasklist: "l1",
      showCompleted: false,
      dueMax: "2026-07-01T00:00:00.000Z",
    });
  });
});

describe("quickAddTool", () => {
  it("uses the text as the title and lifts a trailing due:DATE", async () => {
    const insertTask = vi.fn().mockResolvedValue({ id: "t1", title: "Call dentist" });
    await quickAddTool.handler(
      { task_list_id: "l1", text: "Call dentist due:2026-07-04" },
      ctxWith({ insertTask }),
    );
    expect(insertTask).toHaveBeenCalledWith({
      tasklist: "l1",
      body: { title: "Call dentist", due: "2026-07-04T00:00:00.000Z" },
    });
  });

  it("creates a due-less task when no due token is present", async () => {
    const insertTask = vi.fn().mockResolvedValue({ id: "t1", title: "Water plants" });
    await quickAddTool.handler(
      { task_list_id: "l1", text: "Water plants" },
      ctxWith({ insertTask }),
    );
    expect(insertTask).toHaveBeenCalledWith({
      tasklist: "l1",
      body: { title: "Water plants" },
    });
  });

  it("rejects text that has no title after stripping the due token", async () => {
    const insertTask = vi.fn();
    await expect(
      quickAddTool.handler(
        { task_list_id: "l1", text: "  due:2026-07-04" },
        ctxWith({ insertTask }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(insertTask).not.toHaveBeenCalled();
  });
});
