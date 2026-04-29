import { describe, it, expect, vi } from "vitest";
import { ValidationError, NotFoundError } from "smart-mcp-core";
import {
  listInbox,
  searchEmails,
  readEmail,
  getThread,
  bulkReadMessages,
} from "../tools/inbox.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function makeMessageRaw(opts: {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  date?: string;
  labels?: string[];
  size?: number;
}): unknown {
  const headers: Array<{ name: string; value: string }> = [];
  if (opts.from !== undefined) headers.push({ name: "From", value: opts.from });
  if (opts.to !== undefined) headers.push({ name: "To", value: opts.to });
  if (opts.subject !== undefined)
    headers.push({ name: "Subject", value: opts.subject });
  if (opts.date !== undefined) headers.push({ name: "Date", value: opts.date });
  return {
    id: opts.id,
    threadId: opts.threadId ?? `thr_${opts.id}`,
    labelIds: opts.labels ?? ["INBOX"],
    snippet: opts.snippet ?? "",
    sizeEstimate: opts.size ?? 0,
    payload: { headers },
  };
}

function makeContext(
  overrides: Partial<EmailClient> = {},
): { context: EmailContext; client: Record<string, ReturnType<typeof vi.fn>> } {
  const client = {
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    getThread: vi.fn(),
    ...overrides,
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return {
    context: { client: client as unknown as EmailClient },
    client,
  };
}

describe("list_inbox tool", () => {
  it("returns slim messages mapped from Gmail metadata fetches", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_acct, id) =>
      makeMessageRaw({
        id,
        from: `${id}@example.com`,
        to: "me@example.com",
        subject: `subject-${id}`,
        snippet: `snip-${id}`,
        size: 100,
      }),
    );

    const result = await listInbox.handler(
      { account: "alice", max_results: 10, label: "INBOX" },
      context,
    );

    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      labelIds: "INBOX",
      maxResults: 10,
    });
    expect(result.count).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      id: "m1",
      from: "m1@example.com",
      subject: "subject-m1",
    });
  });

  it("uses default max_results=10 and label=INBOX", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({ messages: [], resultSizeEstimate: 0 });

    const parsed = (listInbox.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof listInbox.handler>[0];
    }).parse({ account: "alice" });
    await listInbox.handler(parsed, context);

    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      labelIds: "INBOX",
      maxResults: 10,
    });
  });

  it("surfaces nextPageToken when present", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      nextPageToken: "tok_next",
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    const result = await listInbox.handler(
      { account: "alice", max_results: 10, label: "INBOX" },
      context,
    );
    expect(result.next_page_token).toBe("tok_next");
  });

  it("returns empty list when 0 matches", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({ messages: [], resultSizeEstimate: 0 });

    const result = await listInbox.handler(
      { account: "alice", max_results: 10, label: "INBOX" },
      context,
    );
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("rejects empty account via zod schema", () => {
    expect(() =>
      (listInbox.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "" }),
    ).toThrow();
  });
});

describe("search_emails tool", () => {
  it("passes q through to listMessages and maps results", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        subject: "hi from newsletter",
        from: "news@example.com",
      }),
    );

    const result = await searchEmails.handler(
      { account: "alice", q: "from:newsletter older_than:7d", max_results: 25 },
      context,
    );

    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      q: "from:newsletter older_than:7d",
      maxResults: 25,
    });
    expect(result.messages[0]?.subject).toBe("hi from newsletter");
  });

  it("uses default max_results=25", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({ messages: [], resultSizeEstimate: 0 });

    const parsed = (searchEmails.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof searchEmails.handler>[0];
    }).parse({ account: "alice", q: "test" });
    await searchEmails.handler(parsed, context);

    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      q: "test",
      maxResults: 25,
    });
  });

  it("propagates nextPageToken to caller", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      nextPageToken: "tok_search",
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    const result = await searchEmails.handler(
      { account: "alice", q: "test", max_results: 25 },
      context,
    );
    expect(result.next_page_token).toBe("tok_search");
  });

  it("returns count matching number of mapped messages", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
        { id: "m3", threadId: "t3" },
      ],
      resultSizeEstimate: 3,
    });
    client.getMessage.mockImplementation(async (_a, id) =>
      makeMessageRaw({ id }),
    );

    const result = await searchEmails.handler(
      { account: "alice", q: "test", max_results: 25 },
      context,
    );
    expect(result.count).toBe(3);
    expect(result.messages).toHaveLength(3);
  });

  it("rejects empty q via zod", () => {
    expect(() =>
      (searchEmails.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", q: "" }),
    ).toThrow();
  });

  it("returns empty array on zero matches", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({ messages: [], resultSizeEstimate: 0 });

    const result = await searchEmails.handler(
      { account: "alice", q: "no_match", max_results: 25 },
      context,
    );
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });
});

describe("read_email tool", () => {
  it("returns slim shape with body_text and body_html for full format", async () => {
    const { context, client } = makeContext();
    client.getMessage.mockResolvedValue({
      id: "msg_1",
      threadId: "thr_1",
      labelIds: ["INBOX"],
      snippet: "preview",
      sizeEstimate: 500,
      payload: {
        headers: [
          { name: "From", value: "a@x.com" },
          { name: "Subject", value: "S" },
        ],
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("plain content") } },
          { mimeType: "text/html", body: { data: b64url("<b>html content</b>") } },
        ],
      },
    });

    const result = await readEmail.handler(
      { account: "alice", id: "msg_1", format: "full" },
      context,
    );

    expect(client.getMessage).toHaveBeenCalledWith("alice", "msg_1", "full");
    expect(result.id).toBe("msg_1");
    expect(result.body_text).toBe("plain content");
    expect(result.body_html).toBe("<b>html content</b>");
  });

  it("defaults format to full", async () => {
    const { context, client } = makeContext();
    client.getMessage.mockResolvedValue({
      id: "msg_1",
      threadId: "thr_1",
      payload: { headers: [], body: { data: b64url("plain") }, mimeType: "text/plain" },
    });

    const parsed = (readEmail.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof readEmail.handler>[0];
    }).parse({ account: "alice", id: "msg_1" });
    await readEmail.handler(parsed, context);

    expect(client.getMessage).toHaveBeenCalledWith("alice", "msg_1", "full");
  });

  it("respects metadata format and returns no bodies", async () => {
    const { context, client } = makeContext();
    client.getMessage.mockResolvedValue(
      makeMessageRaw({ id: "msg_1", subject: "hi" }),
    );

    const result = await readEmail.handler(
      { account: "alice", id: "msg_1", format: "metadata" },
      context,
    );
    expect(client.getMessage).toHaveBeenCalledWith("alice", "msg_1", "metadata");
    expect(result.body_text).toBeUndefined();
    expect(result.body_html).toBeUndefined();
  });

  it("propagates NotFoundError for missing message id", async () => {
    const { context, client } = makeContext();
    client.getMessage.mockRejectedValue(new NotFoundError("not found"));

    await expect(
      readEmail.handler(
        { account: "alice", id: "missing", format: "full" },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("get_thread tool", () => {
  it("returns thread with subject from first message and slim message list", async () => {
    const { context, client } = makeContext();
    client.getThread.mockResolvedValue({
      id: "thr_1",
      messages: [
        makeMessageRaw({
          id: "m1",
          threadId: "thr_1",
          subject: "First subject",
          from: "a@x.com",
        }),
        makeMessageRaw({
          id: "m2",
          threadId: "thr_1",
          subject: "Re: First subject",
          from: "b@y.com",
        }),
      ],
    });

    const result = await getThread.handler(
      { account: "alice", id: "thr_1" },
      context,
    );

    expect(client.getThread).toHaveBeenCalledWith("alice", "thr_1", "metadata");
    expect(result.id).toBe("thr_1");
    expect(result.subject).toBe("First subject");
    expect(result.message_count).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.from).toBe("a@x.com");
  });

  it("handles empty thread message list (defensive)", async () => {
    const { context, client } = makeContext();
    client.getThread.mockResolvedValue({ id: "thr_x", messages: [] });

    const result = await getThread.handler(
      { account: "alice", id: "thr_x" },
      context,
    );
    expect(result.message_count).toBe(0);
    expect(result.subject).toBe("");
    expect(result.messages).toEqual([]);
  });

  it("propagates NotFoundError from client", async () => {
    const { context, client } = makeContext();
    client.getThread.mockRejectedValue(new NotFoundError("missing thread"));

    await expect(
      getThread.handler({ account: "alice", id: "missing" }, context),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("bulk_read_messages tool", () => {
  it("fetches each id sequentially and returns mapped slim messages", async () => {
    const { context, client } = makeContext();
    const callOrder: string[] = [];
    client.getMessage.mockImplementation(async (_a, id: string) => {
      callOrder.push(id);
      return makeMessageRaw({ id, subject: `sub-${id}` });
    });

    const result = await bulkReadMessages.handler(
      { account: "alice", ids: ["m1", "m2", "m3"] },
      context,
    );

    expect(client.getMessage).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual(["m1", "m2", "m3"]);
    expect(result.count).toBe(3);
    expect(result.errors).toBe(0);
    expect(result.messages).toHaveLength(3);
  });

  it("includes per-id error placeholder for NotFoundError without aborting batch", async () => {
    const { context, client } = makeContext();
    client.getMessage.mockImplementation(async (_a, id: string) => {
      if (id === "missing") throw new NotFoundError("not found");
      return makeMessageRaw({ id });
    });

    const result = await bulkReadMessages.handler(
      { account: "alice", ids: ["m1", "missing", "m3"] },
      context,
    );

    expect(result.count).toBe(3);
    expect(result.errors).toBe(1);
    expect(result.messages[1]).toEqual({ id: "missing", error: "not_found" });
    expect((result.messages[0] as { id: string }).id).toBe("m1");
    expect((result.messages[2] as { id: string }).id).toBe("m3");
  });

  it("rejects ids array length > 100 via zod", () => {
    const tooMany = Array.from({ length: 101 }, (_v, i) => `m${i}`);
    expect(() =>
      (bulkReadMessages.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", ids: tooMany }),
    ).toThrow();
  });

  it("rejects empty ids array via zod", () => {
    expect(() =>
      (bulkReadMessages.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", ids: [] }),
    ).toThrow();
  });
});
