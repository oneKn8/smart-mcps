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

  it("neutralizes leading list/quote markers in a snippet so it stays a paragraph", async () => {
    const listMessages = vi.fn().mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
        { id: "m3", threadId: "t3" },
      ],
      resultSizeEstimate: 3,
    });
    const mkThread = (id: string, snippet: string) => ({
      id,
      snippet,
      messages: [
        {
          payload: {
            headers: [
              { name: "Subject", value: "Sub" },
              { name: "From", value: "a@b.com" },
            ],
          },
        },
      ],
    });
    const getThread = vi
      .fn()
      .mockResolvedValueOnce(mkThread("t1", "- bullet"))
      .mockResolvedValueOnce(mkThread("t2", "1. ordered"))
      .mockResolvedValueOnce(mkThread("t3", "> quote"));
    const ctx = makeCtx({ email: { listMessages, getThread } });

    await run(inboxDigestDocTool, { count: 3 }, ctx);

    const md = renderedMarkdown(ctx);
    // Snippets are escaped, so none render as a list item or blockquote line.
    expect(md).toContain("\\- bullet");
    expect(md).toContain("1\\. ordered");
    expect(md).toContain("\\> quote");
    expect(md).not.toMatch(/^- bullet$/m);
    expect(md).not.toMatch(/^1\. ordered$/m);
    expect(md).not.toMatch(/^> quote$/m);
  });

  it("neutralizes a backtick in the query so the inline-code span is not broken", async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValue({ messages: [], resultSizeEstimate: 0 });
    const getThread = vi.fn();
    const ctx = makeCtx({ email: { listMessages, getThread } });

    await run(inboxDigestDocTool, { query: "subject:`weird`" }, ctx);

    const md = renderedMarkdown(ctx);
    // The query renders intact and no stray backtick leaks out to break the
    // surrounding code span (the renderer consumes a balanced pair).
    expect(md).toContain("subject:weird");
    expect(md).not.toContain("`");
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
