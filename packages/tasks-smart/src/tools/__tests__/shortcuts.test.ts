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
    // dueMin is widened by one day (Jun 30, not Jul 1): it is only a payload
    // trim hint, so a looser lower edge avoids dropping tasks-due-today if
    // Google treats dueMin as exclusive. maxResults batches pages of 100.
    expect(listTasks).toHaveBeenCalledWith({
      tasklist: "l1",
      showCompleted: false,
      dueMin: "2026-06-30T00:00:00.000Z",
      dueMax: "2026-07-02T00:00:00.000Z",
      maxResults: 100,
    });
  });

  it("includes a task due exactly today (dueMin lower edge is not tangent)", async () => {
    // The membership test is the exact date-string compare; the widened dueMin
    // must never cause a task due exactly today to be trimmed away.
    const listTasks = vi.fn().mockResolvedValue({ items: [dueJul01] });
    const out = await todayTasksTool.handler(
      { task_list_id: "l1" },
      ctxWith({ listTasks }),
    );
    expect(out.tasks.map((e) => e.task.id)).toEqual(["t_jul01"]);
  });

  it("follows nextPageToken to fetch ALL pages, not just the first 20", async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => ({
      ...dueJul01,
      id: `t_p1_${i}`,
    }));
    const page2 = Array.from({ length: 5 }, (_, i) => ({
      ...dueJul01,
      id: `t_p2_${i}`,
    }));
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce({ items: page1, nextPageToken: "PAGE2" })
      .mockResolvedValueOnce({ items: page2 });
    const out = await todayTasksTool.handler(
      { task_list_id: "l1" },
      ctxWith({ listTasks }),
    );
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(listTasks.mock.calls[1]?.[0]).toMatchObject({ pageToken: "PAGE2" });
    expect(out.tasks).toHaveLength(25);
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

  it("passes a dueMax=today trim hint, showCompleted=false, maxResults=100", async () => {
    const listTasks = vi.fn().mockResolvedValue({ items: [] });
    await overdueTasksTool.handler(
      { task_list_id: "l1" },
      ctxWith({ listTasks }),
    );
    expect(listTasks).toHaveBeenCalledWith({
      tasklist: "l1",
      showCompleted: false,
      dueMax: "2026-07-01T00:00:00.000Z",
      maxResults: 100,
    });
  });

  it("returns ALL 25 tasks of a 2-page overdue list (no silent 20-cap)", async () => {
    // Google's default page size is 20; an overdue list of 25 must surface all
    // 25 by following nextPageToken, not silently drop the tail.
    const page1 = Array.from({ length: 20 }, (_, i) => ({
      ...dueJun30,
      id: `o1_${i}`,
    }));
    const page2 = Array.from({ length: 5 }, (_, i) => ({
      ...dueJun30,
      id: `o2_${i}`,
    }));
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce({ items: page1, nextPageToken: "PAGE2" })
      .mockResolvedValueOnce({ items: page2 });
    const out = await overdueTasksTool.handler(
      { task_list_id: "l1" },
      ctxWith({ listTasks }),
    );
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(listTasks.mock.calls[1]?.[0]).toMatchObject({ pageToken: "PAGE2" });
    expect(out.tasks).toHaveLength(25);
    expect(out.tasks.every((e) => e.task.due === "2026-06-30")).toBe(true);
  });

  it("paginates the all-lists scan so >1 page of lists is not truncated", async () => {
    // resolveListIds must follow nextPageToken too, or accounts with more lists
    // than one page would have their later lists silently skipped.
    const listTaskLists = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: "l1" }], nextPageToken: "L2" })
      .mockResolvedValueOnce({ items: [{ id: "l2" }] });
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce({ items: [dueJun30] })
      .mockResolvedValueOnce({ items: [{ ...dueJun30, id: "o_l2" }] });
    const out = await overdueTasksTool.handler(
      {},
      ctxWith({ listTaskLists, listTasks }),
    );
    expect(listTaskLists).toHaveBeenCalledTimes(2);
    expect(listTaskLists.mock.calls[1]?.[0]).toMatchObject({ pageToken: "L2" });
    expect(out.tasks.map((e) => e.task_list_id).sort()).toEqual(["l1", "l2"]);
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

  it("rejects a well-formed but impossible due date locally (no API call)", async () => {
    // `due:2026-02-30` matches the YYYY-MM-DD shape but is not a real date.
    // It must be rejected before reaching the API, not 400'd opaquely.
    const insertTask = vi.fn();
    await expect(
      quickAddTool.handler(
        { task_list_id: "l1", text: "Pay rent due:2026-02-30" },
        ctxWith({ insertTask }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(insertTask).not.toHaveBeenCalled();
  });
});
