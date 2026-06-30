import { describe, it, expect, vi } from "vitest";
import { taskToCalendarBlockTool } from "../tools/task-to-calendar-block.js";
import { FlowStepError } from "../flow-error.js";
import { makeCtx, run } from "./helpers.js";

describe("task_to_calendar_block", () => {
  it("reads the task and creates a timed block", async () => {
    const getTask = vi
      .fn()
      .mockResolvedValue({ id: "task_1", title: "Write report", notes: "outline first" });
    const insertEvent = vi.fn().mockResolvedValue({
      id: "ev_1",
      start: { dateTime: "2026-07-01T14:00:00-05:00" },
      end: { dateTime: "2026-07-01T14:30:00-05:00" },
      htmlLink: "https://cal/ev_1",
    });
    const ctx = makeCtx({ tasks: { getTask }, calendar: { insertEvent } });

    const out = await run(
      taskToCalendarBlockTool,
      { task_id: "task_1", date: "2026-07-01", start_time: "14:00", duration_minutes: 30 },
      ctx,
    );

    expect(getTask).toHaveBeenCalledWith({ tasklist: "@default", task: "task_1" });
    const arg = insertEvent.mock.calls[0][0];
    expect(arg.calendarId).toBe("primary");
    expect(arg.body.summary).toBe("Task: Write report");
    expect(arg.body.description).toContain("outline first");
    expect(arg.body.description).toContain("from Google Task task_1");
    expect(arg.body.start).toEqual({
      dateTime: "2026-07-01T14:00:00-05:00",
      timeZone: "America/Chicago",
    });
    expect(arg.body.end).toEqual({
      dateTime: "2026-07-01T14:30:00-05:00",
      timeZone: "America/Chicago",
    });
    expect(out).toMatchObject({
      event_id: "ev_1",
      calendar_id: "primary",
      task_id: "task_1",
      title: "Write report",
      start: "2026-07-01T14:00:00-05:00",
      end: "2026-07-01T14:30:00-05:00",
      html_link: "https://cal/ev_1",
    });
  });

  it("defaults start to 09:00 and duration to 60 minutes", async () => {
    const getTask = vi.fn().mockResolvedValue({ id: "t", title: "Thing" });
    const insertEvent = vi.fn().mockResolvedValue({ id: "ev" });
    const ctx = makeCtx({ tasks: { getTask }, calendar: { insertEvent } });

    await run(taskToCalendarBlockTool, { task_id: "t", date: "2026-07-01" }, ctx);

    const arg = insertEvent.mock.calls[0][0];
    expect(arg.body.start.dateTime).toBe("2026-07-01T09:00:00-05:00");
    expect(arg.body.end.dateTime).toBe("2026-07-01T10:00:00-05:00");
  });

  it("reports which step failed when the block cannot be created", async () => {
    const getTask = vi.fn().mockResolvedValue({ id: "t", title: "Write report" });
    const insertEvent = vi.fn().mockRejectedValue(new Error("calendar busy"));
    const ctx = makeCtx({ tasks: { getTask }, calendar: { insertEvent } });

    const err = await run(
      taskToCalendarBlockTool,
      { task_id: "t", date: "2026-07-01" },
      ctx,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(FlowStepError);
    expect(err.step).toBe("create_block");
    expect(err.message).toContain('read task "Write report"');
    expect(err.message).toContain("calendar busy");
  });

  it("reports a read_task failure without a phantom block", async () => {
    const getTask = vi.fn().mockRejectedValue(new Error("task not found"));
    const insertEvent = vi.fn();
    const ctx = makeCtx({ tasks: { getTask }, calendar: { insertEvent } });

    const err = await run(
      taskToCalendarBlockTool,
      { task_id: "nope", date: "2026-07-01" },
      ctx,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(FlowStepError);
    expect(err.step).toBe("read_task");
    expect(insertEvent).not.toHaveBeenCalled();
  });
});
