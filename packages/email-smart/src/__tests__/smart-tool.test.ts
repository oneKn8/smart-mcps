import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dailyStatus, inboxZeroDryRun } from "../tools/smart.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-smart-tool-test-"));
}

function writeAudit(home: string, lines: Array<Record<string, string>>): void {
  const dir = path.join(home, ".santo-agent", "audit");
  fs.mkdirSync(dir, { recursive: true });
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "send-log.jsonl"), text);
}

function row(
  ts: string,
  account: string,
  to: string,
  subject: string,
  id: string,
): Record<string, string> {
  return {
    ts,
    account,
    to,
    cc: "",
    bcc: "",
    subject,
    gmail_id: id,
    gmail_thread_id: `thr_${id}`,
  };
}

function makeContext(home: string): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    listLabels: vi.fn(),
    getLabel: vi.fn(),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return {
    context: { client: client as unknown as EmailClient, home },
    client,
  };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// -------------------- daily_status --------------------

describe("daily_status tool", () => {
  it("counts sends in last 24h, returns latest_at, and inbox unread", async () => {
    writeAudit(tmpHome, [
      // Outside window (3 days ago)
      row("2026-04-25T12:00:00.000Z", "alice", "x@x", "old", "m_old"),
      // Inside window
      row("2026-04-28T08:00:00.000Z", "alice", "a@x", "first", "m1"),
      row("2026-04-28T11:30:00.000Z", "alice", "b@x", "second", "m2"),
      // Different account — must be excluded
      row("2026-04-28T11:00:00.000Z", "bob", "c@x", "other", "m3"),
    ]);
    const { context, client } = makeContext(tmpHome);
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 42,
    });

    const result = await dailyStatus.handler(
      { account: "alice", hours: 24 },
      context,
    );

    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      q: "is:unread",
      maxResults: 1,
    });
    expect(result.account).toBe("alice");
    expect(result.window_hours).toBe(24);
    expect(result.sends.total).toBe(2);
    expect(result.sends.latest_at).toBe("2026-04-28T11:30:00.000Z");
    expect(result.sends.recent.map((e) => e.gmail_id)).toEqual(["m2", "m1"]);
    expect(result.inbox.unread_count).toBe(42);
  });

  it("uses default hours=24 when not provided", async () => {
    writeAudit(tmpHome, [
      row("2026-04-28T11:00:00.000Z", "alice", "a@x", "s", "m1"),
    ]);
    const { context, client } = makeContext(tmpHome);
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const parsed = (dailyStatus.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof dailyStatus.handler>[0];
    }).parse({ account: "alice" });
    const result = await dailyStatus.handler(parsed, context);
    expect(result.window_hours).toBe(24);
    expect(result.sends.total).toBe(1);
  });

  it("includes a note when there are no sends in the window", async () => {
    writeAudit(tmpHome, [
      // Way outside window
      row("2026-04-01T11:00:00.000Z", "alice", "a@x", "old", "m1"),
    ]);
    const { context, client } = makeContext(tmpHome);
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const result = await dailyStatus.handler(
      { account: "alice", hours: 24 },
      context,
    );
    expect(result.sends.total).toBe(0);
    expect(result.sends.latest_at).toBeNull();
    expect(result.notes.some((n) => n.includes("no sends"))).toBe(true);
  });

  it("surfaces a note when a recent entry has empty gmail_id", async () => {
    writeAudit(tmpHome, [
      row("2026-04-28T10:00:00.000Z", "alice", "a@x", "ok", "m1"),
      // Empty gmail_id simulates partial-write warning case
      {
        ts: "2026-04-28T10:30:00.000Z",
        account: "alice",
        to: "b@x",
        cc: "",
        bcc: "",
        subject: "partial",
        gmail_id: "",
        gmail_thread_id: "",
      },
    ]);
    const { context, client } = makeContext(tmpHome);
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const result = await dailyStatus.handler(
      { account: "alice", hours: 24 },
      context,
    );
    expect(result.sends.total).toBe(2);
    expect(
      result.notes.some((n) => n.includes("missing gmail_id")),
    ).toBe(true);
  });

  it("caps recent entries at 10 most-recent but reports total accurately", async () => {
    const lines: Array<Record<string, string>> = [];
    for (let i = 0; i < 15; i++) {
      const ts = new Date(
        Date.UTC(2026, 3, 28, 11, i, 0), // 11:00..11:14 UTC
      ).toISOString();
      lines.push(row(ts, "alice", "x@x", `s${i}`, `m${i}`));
    }
    writeAudit(tmpHome, lines);
    const { context, client } = makeContext(tmpHome);
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const result = await dailyStatus.handler(
      { account: "alice", hours: 24 },
      context,
    );
    expect(result.sends.total).toBe(15);
    expect(result.sends.recent).toHaveLength(10);
    expect(result.sends.recent[0]?.gmail_id).toBe("m14");
    expect(result.sends.recent[9]?.gmail_id).toBe("m5");
  });

  it("handles missing audit log (no sends) gracefully", async () => {
    const { context, client } = makeContext(tmpHome);
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 7,
    });

    const result = await dailyStatus.handler(
      { account: "alice", hours: 24 },
      context,
    );
    expect(result.sends.total).toBe(0);
    expect(result.sends.recent).toEqual([]);
    expect(result.sends.latest_at).toBeNull();
    expect(result.inbox.unread_count).toBe(7);
  });

  it("respects a custom hours window (e.g. 1h)", async () => {
    writeAudit(tmpHome, [
      // 30 minutes ago — inside 1h window
      row("2026-04-28T11:30:00.000Z", "alice", "a@x", "in", "m_in"),
      // 2 hours ago — outside 1h window
      row("2026-04-28T10:00:00.000Z", "alice", "b@x", "out", "m_out"),
    ]);
    const { context, client } = makeContext(tmpHome);
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const result = await dailyStatus.handler(
      { account: "alice", hours: 1 },
      context,
    );
    expect(result.sends.total).toBe(1);
    expect(result.sends.recent.map((e) => e.gmail_id)).toEqual(["m_in"]);
  });
});

// -------------------- inbox_zero_dry_run --------------------

function makeRaw(opts: {
  id: string;
  from?: string;
  subject?: string;
  date?: string;
  labels?: string[];
}): unknown {
  const headers: Array<{ name: string; value: string }> = [];
  if (opts.from !== undefined)
    headers.push({ name: "From", value: opts.from });
  if (opts.subject !== undefined)
    headers.push({ name: "Subject", value: opts.subject });
  if (opts.date !== undefined)
    headers.push({ name: "Date", value: opts.date });
  return {
    id: opts.id,
    threadId: `thr_${opts.id}`,
    labelIds: opts.labels ?? ["INBOX"],
    snippet: "",
    sizeEstimate: 0,
    payload: { headers },
  };
}

describe("inbox_zero_dry_run tool", () => {
  it("groups by domain and identifies a noisy newsletter sender", async () => {
    const { context, client } = makeContext(tmpHome);
    const ids = Array.from({ length: 6 }, (_v, i) => `n${i}`);
    client.listMessages.mockResolvedValue({
      messages: ids.map((id) => ({ id, threadId: `thr_${id}` })),
      resultSizeEstimate: 6,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeRaw({
        id,
        from: `Spammy <newsletter@spammy.com>`,
        subject: `Weekly Newsletter ${id}`,
        date: "2026-04-28T11:00:00.000Z",
        labels: ["INBOX"],
      }),
    );

    const result = await inboxZeroDryRun.handler(
      { account: "alice", max: 200 },
      context,
    );

    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      q: "in:inbox",
      maxResults: 200,
    });
    expect(result.account).toBe("alice");
    expect(result.scanned).toBe(6);
    expect(result.noisy_senders).toHaveLength(1);
    const noisy = result.noisy_senders[0]!;
    expect(noisy.from_domain).toBe("spammy.com");
    expect(noisy.count).toBe(6);
    expect(noisy.sample_subjects).toHaveLength(3);
    expect(noisy.suggested_query).toContain("from:@spammy.com");
    expect(noisy.suggested_query).toContain("in:inbox");
  });

  it("identifies stale unread messages older than 30 days", async () => {
    const { context, client } = makeContext(tmpHome);
    // 60 days ago = 2026-02-27 (60 * 86400 ms before 2026-04-28T12:00:00Z)
    const oldDate = new Date(
      Date.UTC(2026, 1, 27, 12, 0, 0),
    ).toUTCString();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "s1", threadId: "thr_s1" },
        { id: "s2", threadId: "thr_s2" },
        { id: "fresh", threadId: "thr_fresh" },
      ],
      resultSizeEstimate: 3,
    });
    client.getMessage.mockImplementation(async (_a, id: string) => {
      if (id === "fresh") {
        return makeRaw({
          id,
          from: "fresh@example.com",
          subject: "Fresh msg",
          date: new Date("2026-04-28T08:00:00.000Z").toUTCString(),
          labels: ["INBOX", "UNREAD"],
        });
      }
      return makeRaw({
        id,
        from: `Sender <${id}@example.com>`,
        subject: `Stale ${id}`,
        date: oldDate,
        labels: ["INBOX", "UNREAD"],
      });
    });

    const result = await inboxZeroDryRun.handler(
      { account: "alice", max: 200 },
      context,
    );
    expect(result.stale_unread).toHaveLength(2);
    expect(result.stale_unread.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(result.stale_unread[0]).toMatchObject({
      from: expect.any(String),
      subject: expect.any(String),
      date: expect.any(String),
    });
  });

  it("does not flag domains below the noisy threshold (NOISY_DOMAIN_MIN=3)", async () => {
    const { context, client } = makeContext(tmpHome);
    const ids = ["a1", "a2"];
    client.listMessages.mockResolvedValue({
      messages: ids.map((id) => ({ id, threadId: `thr_${id}` })),
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeRaw({
        id,
        from: `news <newsletter@borderline.com>`,
        subject: `Newsletter ${id}`,
        date: "2026-04-28T11:00:00.000Z",
        labels: ["INBOX"],
      }),
    );

    const result = await inboxZeroDryRun.handler(
      { account: "alice", max: 200 },
      context,
    );
    expect(result.noisy_senders).toEqual([]);
    expect(result.scanned).toBe(2);
  });

  it("surfaces total_unread in output and uses 'unread overall' framing when scan window is clean but unread is large", async () => {
    const { context, client } = makeContext(tmpHome);
    // First call (in:inbox): 1 benign message in window. Second call (is:unread): 14155 total.
    client.listMessages.mockImplementation(async (_account, opts: { q?: string; maxResults?: number }) => {
      if (opts.q === "is:unread") {
        return { messages: [], resultSizeEstimate: 14155 };
      }
      return {
        messages: [{ id: "ok", threadId: "thr_ok" }],
        resultSizeEstimate: 1,
      };
    });
    client.getMessage.mockResolvedValue(
      makeRaw({
        id: "ok",
        from: "person@personal.com",
        subject: "Lunch?",
        date: new Date("2026-04-28T11:00:00.000Z").toUTCString(),
        labels: ["INBOX"],
      }),
    );

    const result = await inboxZeroDryRun.handler(
      { account: "alice", max: 1 },
      context,
    );
    expect(result.total_unread).toBe(14155);
    expect(result.noisy_senders).toEqual([]);
    expect(result.stale_unread).toEqual([]);
    expect(result.suggested_actions.some((s) => s.includes("14155 unread overall"))).toBe(true);
    expect(result.suggested_actions.some((s) => s === "Inbox is healthy" || s.startsWith("Inbox is healthy"))).toBe(false);
  });

  it("returns 'Inbox is healthy' suggestion when no noise and no stale", async () => {
    const { context, client } = makeContext(tmpHome);
    client.listMessages.mockResolvedValue({
      messages: [{ id: "ok", threadId: "thr_ok" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeRaw({
        id: "ok",
        from: "person@personal.com",
        subject: "Lunch?",
        date: new Date("2026-04-28T11:00:00.000Z").toUTCString(),
        labels: ["INBOX"],
      }),
    );

    const result = await inboxZeroDryRun.handler(
      { account: "alice", max: 200 },
      context,
    );
    expect(result.noisy_senders).toEqual([]);
    expect(result.stale_unread).toEqual([]);
    expect(result.suggested_actions.some((s) => s.includes("healthy"))).toBe(
      true,
    );
    expect(result.total_unread).toBe(1);
  });

  it("uses default max=200 when not provided", async () => {
    const { context, client } = makeContext(tmpHome);
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const parsed = (inboxZeroDryRun.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof inboxZeroDryRun.handler>[0];
    }).parse({ account: "alice" });
    await inboxZeroDryRun.handler(parsed, context);
    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      q: "in:inbox",
      maxResults: 200,
    });
  });

  it("caps stale_unread output at 20 entries", async () => {
    const { context, client } = makeContext(tmpHome);
    const ids = Array.from({ length: 25 }, (_v, i) => `st${i}`);
    const oldDate = new Date(
      Date.UTC(2026, 1, 27, 12, 0, 0),
    ).toUTCString();
    client.listMessages.mockResolvedValue({
      messages: ids.map((id) => ({ id, threadId: `thr_${id}` })),
      resultSizeEstimate: 25,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeRaw({
        id,
        from: `<${id}@distinct${id}.com>`,
        subject: `S ${id}`,
        date: oldDate,
        labels: ["INBOX", "UNREAD"],
      }),
    );

    const result = await inboxZeroDryRun.handler(
      { account: "alice", max: 200 },
      context,
    );
    expect(result.stale_unread).toHaveLength(20);
    expect(result.scanned).toBe(25);
  });

  it("rejects max above 500 via zod", () => {
    expect(() =>
      (inboxZeroDryRun.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", max: 501 }),
    ).toThrow();
  });
});
