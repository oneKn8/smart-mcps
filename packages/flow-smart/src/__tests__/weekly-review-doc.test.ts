import { describe, it, expect, vi } from "vitest";
import { weeklyReviewDocTool } from "../tools/weekly-review-doc.js";
import { FlowStepError } from "../flow-error.js";
import { makeCtx, renderedMarkdown, run } from "./helpers.js";

const TASKS = {
  items: [
    { id: "o1", title: "Open A", status: "needsAction", due: "2026-07-02" },
    {
      id: "c1",
      title: "Done B",
      status: "completed",
      completed: "2026-06-30T12:00:00.000Z",
    },
    {
      id: "c0",
      title: "Done Last Week",
      status: "completed",
      completed: "2026-06-20T12:00:00.000Z",
    },
  ],
};
const EVENTS = {
  items: [
    { id: "e1", summary: "Standup", start: { dateTime: "2026-06-30T09:00:00-05:00" } },
  ],
};

describe("weekly_review_doc", () => {
  it("gathers tasks + events for the week and renders a doc", async () => {
    const listTaskLists = vi.fn().mockResolvedValue({ items: [{ id: "L1" }] });
    const listTasks = vi.fn().mockResolvedValue(TASKS);
    const listEvents = vi.fn().mockResolvedValue(EVENTS);
    const ctx = makeCtx({
      tasks: { listTaskLists, listTasks },
      calendar: { listEvents },
    });

    const out = await run(weeklyReviewDocTool, { week_of: "2026-07-01" }, ctx);

    // Week of 2026-07-01 (Wed) -> Mon 2026-06-29 .. Sun 2026-07-05.
    expect(listEvents).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-06-29T00:00:00-05:00",
      timeMax: "2026-07-06T00:00:00-05:00",
      maxResults: 250,
    });
    expect(listTasks).toHaveBeenCalledWith({
      tasklist: "L1",
      showCompleted: true,
      showHidden: true,
    });

    // Only the in-week completion counts; last week's is excluded.
    expect(out).toMatchObject({
      document_id: "doc1",
      url: "https://docs.google.com/document/d/doc1/edit",
      week_start: "2026-06-29",
      week_end: "2026-07-05",
      open_task_count: 1,
      completed_task_count: 1,
      event_count: 1,
    });

    const md = renderedMarkdown(ctx);
    expect(md).toContain("Open Tasks (1)");
    expect(md).toContain("Open A");
    expect(md).toContain("Completed This Week (1)");
    expect(md).toContain("Standup");
    expect(md).not.toContain("Done Last Week");
  });

  it("propagates partial progress if the calendar fetch fails", async () => {
    const listTaskLists = vi.fn().mockResolvedValue({ items: [{ id: "L1" }] });
    const listTasks = vi.fn().mockResolvedValue(TASKS);
    const listEvents = vi.fn().mockRejectedValue(new Error("calendar down"));
    const ctx = makeCtx({
      tasks: { listTaskLists, listTasks },
      calendar: { listEvents },
    });

    const err = await run(weeklyReviewDocTool, { week_of: "2026-07-01" }, ctx).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FlowStepError);
    expect(err.step).toBe("gather_events");
    expect(err.message).toContain("gathered 1 open + 1 completed tasks");
    expect(err.message).toContain("calendar down");
    expect(ctx.docs.createDocument).not.toHaveBeenCalled();
  });
});
