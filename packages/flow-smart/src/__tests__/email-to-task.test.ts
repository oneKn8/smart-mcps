import { describe, it, expect, vi } from "vitest";
import { emailToTaskTool } from "../tools/email-to-task.js";
import { FlowStepError } from "../flow-error.js";
import { makeCtx, run } from "./helpers.js";

const THREAD = {
  id: "t1",
  snippet: "thread preview",
  messages: [
    { snippet: "msg snip", payload: { headers: [{ name: "Subject", value: "Project kickoff" }] } },
  ],
};

describe("email_to_task", () => {
  it("reads a thread and files a task (with due)", async () => {
    const getThread = vi.fn().mockResolvedValue(THREAD);
    const insertTask = vi.fn().mockResolvedValue({
      id: "task_1",
      title: "Project kickoff",
      notes: "thread preview\n\nFrom Gmail thread t1",
      status: "needsAction",
      due: "2026-07-04T00:00:00.000Z",
    });
    const ctx = makeCtx({ email: { getThread }, tasks: { insertTask } });

    const out = await run(
      emailToTaskTool,
      { thread_id: "t1", due: "2026-07-04" },
      ctx,
    );

    expect(getThread).toHaveBeenCalledWith("acct", "t1", "metadata");
    expect(insertTask).toHaveBeenCalledWith({
      tasklist: "@default",
      body: {
        title: "Project kickoff",
        notes: "thread preview\n\nFrom Gmail thread t1",
        due: "2026-07-04T00:00:00.000Z",
      },
    });
    expect(out).toMatchObject({
      task_id: "task_1",
      tasklist: "@default",
      title: "Project kickoff",
      due: "2026-07-04",
      source: { thread_id: "t1", message_id: null },
    });
  });

  it("reads a single message when message_id is given", async () => {
    const getMessage = vi.fn().mockResolvedValue({
      snippet: "ping",
      payload: { headers: [{ name: "Subject", value: "Re: invoice" }] },
    });
    const insertTask = vi
      .fn()
      .mockResolvedValue({ id: "task_2", title: "Re: invoice" });
    const ctx = makeCtx({ email: { getMessage }, tasks: { insertTask } });

    const out = await run(emailToTaskTool, { message_id: "m9" }, ctx);

    expect(getMessage).toHaveBeenCalledWith("acct", "m9", "metadata");
    const body = insertTask.mock.calls[0][0].body;
    expect(body.title).toBe("Re: invoice");
    expect(body.notes).toContain("From Gmail message m9");
    expect(body.due).toBeUndefined();
    expect(out.source).toEqual({ thread_id: null, message_id: "m9" });
  });

  it("rejects giving both or neither id", () => {
    expect(() => emailToTaskTool.inputSchema.parse({})).toThrow();
    expect(() =>
      emailToTaskTool.inputSchema.parse({ thread_id: "a", message_id: "b" }),
    ).toThrow();
  });

  it("surfaces partial progress when task creation fails", async () => {
    const getThread = vi.fn().mockResolvedValue(THREAD);
    const insertTask = vi.fn().mockRejectedValue(new Error("Tasks 403"));
    const ctx = makeCtx({ email: { getThread }, tasks: { insertTask } });

    const err = await run(emailToTaskTool, { thread_id: "t1" }, ctx).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FlowStepError);
    expect(err.step).toBe("create_task");
    expect(err.message).toContain('read email "Project kickoff"');
    expect(err.message).toContain("Tasks 403");
  });
});
