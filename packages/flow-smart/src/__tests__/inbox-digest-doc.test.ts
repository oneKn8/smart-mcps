import { describe, it, expect, vi } from "vitest";
import { inboxDigestDocTool } from "../tools/inbox-digest-doc.js";
import { FlowStepError } from "../flow-error.js";
import { makeCtx, renderedMarkdown, run } from "./helpers.js";

function thread(id: string, subject: string, from: string) {
  return {
    id,
    snippet: `${subject} preview`,
    messages: [
      {
        payload: {
          headers: [
            { name: "Subject", value: subject },
            { name: "From", value: from },
          ],
        },
      },
    ],
  };
}

describe("inbox_digest_doc", () => {
  it("dedupes unread messages to distinct threads and renders them", async () => {
    const listMessages = vi.fn().mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t1" }, // same thread -> deduped
        { id: "m3", threadId: "t2" },
      ],
      resultSizeEstimate: 3,
    });
    const getThread = vi
      .fn()
      .mockResolvedValueOnce(thread("t1", "Invoice due", "ap@vendor.com"))
      .mockResolvedValueOnce(thread("t2", "Welcome", "team@app.com"));
    const ctx = makeCtx({ email: { listMessages, getThread } });

    const out = await run(inboxDigestDocTool, { count: 5 }, ctx);

    expect(listMessages).toHaveBeenCalledWith("acct", {
      q: "is:unread in:inbox",
      maxResults: 15,
    });
    expect(getThread).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({
      document_id: "doc1",
      thread_count: 2,
      threads: [
        { thread_id: "t1", subject: "Invoice due", from: "ap@vendor.com" },
        { thread_id: "t2", subject: "Welcome", from: "team@app.com" },
      ],
    });

    const md = renderedMarkdown(ctx);
    expect(md).toContain("Invoice due");
    expect(md).toContain("ap@vendor.com");
    expect(md).toContain("Welcome");
  });

  it("reports partial progress when a thread read fails", async () => {
    const listMessages = vi.fn().mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    const getThread = vi.fn().mockRejectedValue(new Error("gmail 500"));
    const ctx = makeCtx({ email: { listMessages, getThread } });

    const err = await run(inboxDigestDocTool, {}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(FlowStepError);
    expect(err.step).toBe("read_threads");
    expect(err.message).toContain("found 1 unread threads");
    expect(ctx.docs.createDocument).not.toHaveBeenCalled();
  });
});
