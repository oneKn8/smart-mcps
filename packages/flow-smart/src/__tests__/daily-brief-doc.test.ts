import { describe, it, expect, vi } from "vitest";
import { dailyBriefDocTool } from "../tools/daily-brief-doc.js";
import { FlowStepError } from "../flow-error.js";
import { makeCtx, renderedMarkdown, run } from "./helpers.js";

const EVENTS = {
  items: [
    { id: "e1", summary: "Lunch", start: { dateTime: "2026-07-01T12:00:00-05:00" } },
  ],
};
const TASKS = {
  items: [
    { id: "d1", title: "Due one", status: "needsAction", due: "2026-07-01" },
    { id: "o1", title: "Old one", status: "needsAction", due: "2026-06-20" },
    { id: "f1", title: "Future", status: "needsAction", due: "2026-07-09" },
  ],
};

describe("daily_brief_doc", () => {
  it("buckets due-today vs overdue and renders the agenda", async () => {
    const listEvents = vi.fn().mockResolvedValue(EVENTS);
    const listTaskLists = vi.fn().mockResolvedValue({ items: [{ id: "L1" }] });
    const listTasks = vi.fn().mockResolvedValue(TASKS);
    const ctx = makeCtx({
      calendar: { listEvents },
      tasks: { listTaskLists, listTasks },
    });

    const out = await run(dailyBriefDocTool, { date: "2026-07-01" }, ctx);

    expect(listEvents).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-07-01T00:00:00-05:00",
      timeMax: "2026-07-02T00:00:00-05:00",
      maxResults: 250,
    });
    expect(listTasks).toHaveBeenCalledWith({
      tasklist: "L1",
      showCompleted: false,
      dueMax: "2026-07-02T00:00:00.000Z",
      maxResults: 100,
    });
    expect(out).toMatchObject({
      document_id: "doc1",
      date: "2026-07-01",
      event_count: 1,
      due_today_count: 1,
      overdue_count: 1,
    });

    const md = renderedMarkdown(ctx);
    expect(md).toContain("Agenda (1)");
    expect(md).toContain("Lunch");
    expect(md).toContain("Due Today (1)");
    expect(md).toContain("Due one");
    expect(md).toContain("Overdue (1)");
    expect(md).toContain("Old one");
    expect(md).not.toContain("Future");
  });

  it("follows nextPageToken so tasks past the first page are not lost", async () => {
    const listEvents = vi.fn().mockResolvedValue({ items: [] });
    const listTaskLists = vi.fn().mockResolvedValue({ items: [{ id: "L1" }] });
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          { id: "p1", title: "Page one due", status: "needsAction", due: "2026-07-01" },
        ],
        nextPageToken: "tok2",
      })
      .mockResolvedValueOnce({
        items: [
          { id: "p2", title: "Page two overdue", status: "needsAction", due: "2026-06-20" },
        ],
      });
    const ctx = makeCtx({
      calendar: { listEvents },
      tasks: { listTaskLists, listTasks },
    });

    const out = await run(dailyBriefDocTool, { date: "2026-07-01" }, ctx);

    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(listTasks).toHaveBeenNthCalledWith(1, {
      tasklist: "L1",
      showCompleted: false,
      dueMax: "2026-07-02T00:00:00.000Z",
      maxResults: 100,
    });
    expect(listTasks).toHaveBeenNthCalledWith(2, {
      tasklist: "L1",
      showCompleted: false,
      dueMax: "2026-07-02T00:00:00.000Z",
      maxResults: 100,
      pageToken: "tok2",
    });
    expect(out.due_today_count).toBe(1);
    expect(out.overdue_count).toBe(1);

    const md = renderedMarkdown(ctx);
    expect(md).toContain("Page one due");
    expect(md).toContain("Page two overdue");
  });

  it("propagates partial progress when the task fetch fails", async () => {
    const listEvents = vi.fn().mockResolvedValue(EVENTS);
    const listTaskLists = vi.fn().mockResolvedValue({ items: [{ id: "L1" }] });
    const listTasks = vi.fn().mockRejectedValue(new Error("tasks down"));
    const ctx = makeCtx({
      calendar: { listEvents },
      tasks: { listTaskLists, listTasks },
    });

    const err = await run(dailyBriefDocTool, { date: "2026-07-01" }, ctx).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FlowStepError);
    expect(err.step).toBe("gather_tasks");
    expect(err.message).toContain("gathered 1 events");
    expect(ctx.docs.createDocument).not.toHaveBeenCalled();
  });
});
