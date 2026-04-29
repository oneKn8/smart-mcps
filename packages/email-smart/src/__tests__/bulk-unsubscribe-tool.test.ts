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
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import { bulkUnsubscribe } from "../tools/bulk-unsubscribe.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

let savedHome: string | undefined;
let tmpHome: string;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-bulk-unsub-test-"));
}

function writeIdentity(home: string, account: string, body: string): void {
  const dir = path.join(home, ".santo-agent", "identities");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${account}.yaml`), body);
}

function aliceIdentity(): string {
  return [
    "account: alice",
    "email: alice@example.com",
    "display_name: Alice Example",
  ].join("\n");
}

function aliceSmtpIdentity(): string {
  return [
    "account: alice",
    "email: alice@example.com",
    "display_name: Alice Example",
    "transport: smtp",
  ].join("\n");
}

type MakeMsgOpts = {
  id: string;
  threadId?: string;
  from: string;
  subject?: string;
  listUnsub?: string;
  listUnsubPost?: string;
};

function makeMessageRaw(opts: MakeMsgOpts): unknown {
  const headers: Array<{ name: string; value: string }> = [];
  headers.push({ name: "From", value: opts.from });
  if (opts.subject !== undefined)
    headers.push({ name: "Subject", value: opts.subject });
  if (opts.listUnsub !== undefined)
    headers.push({ name: "List-Unsubscribe", value: opts.listUnsub });
  if (opts.listUnsubPost !== undefined)
    headers.push({ name: "List-Unsubscribe-Post", value: opts.listUnsubPost });
  return {
    id: opts.id,
    threadId: opts.threadId ?? `thr_${opts.id}`,
    labelIds: ["INBOX"],
    snippet: "",
    sizeEstimate: 0,
    payload: { headers },
  };
}

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    batchModify: vi.fn(),
    sendMessage: vi.fn(),
  };
  return {
    context: {
      client: client as unknown as EmailClient,
      home: tmpHome,
    },
    client,
  };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
  writeIdentity(tmpHome, "alice", aliceIdentity());
});

afterEach(() => {
  vi.useRealTimers();
  if (fetchSpy !== undefined) {
    fetchSpy.mockRestore();
    fetchSpy = undefined;
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("bulk_unsubscribe tool", () => {
  it("metadata: name and description", () => {
    expect(bulkUnsubscribe.name).toBe("bulk_unsubscribe");
    expect(typeof bulkUnsubscribe.description).toBe("string");
  });

  it("dry_run (default) returns preview, NEVER calls fetch or batchModify or sendMessage", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a: string, id: string) =>
      makeMessageRaw({
        id,
        from: `noreply@spammy.com`,
        subject: `s-${id}`,
        listUnsub: "<https://spammy.com/unsub?token=abc>",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:spammy.com",
        max: 20,
        archive_after: true,
        dry_run: true,
        confirm: false,
      },
      context,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.batchModify).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(result.dry_run).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.archived_count).toBe(0);
    expect(result.by_domain).toHaveLength(1);
    const entry = result.by_domain[0]!;
    expect(entry.from_domain).toBe("spammy.com");
    expect(entry.message_count).toBe(2);
    expect(entry.method).toBe("url");
    expect(entry.attempted).toBe(false);
    expect(entry.success).toBe(false);
  });

  it("confirm=false dry_run=false throws ConfirmRequiredError; never calls fetch", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@spammy.com",
        listUnsub: "<https://spammy.com/u>",
      }),
    );

    await expect(
      bulkUnsubscribe.handler(
        {
          account: "alice",
          q: "from:spammy.com",
          max: 20,
          archive_after: true,
          dry_run: false,
          confirm: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.batchModify).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("URL+mailto with One-Click post header → method=one_click", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>, <mailto:u@a.com>",
        listUnsubPost: "List-Unsubscribe=One-Click",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: false,
        dry_run: true,
        confirm: false,
      },
      context,
    );

    expect(result.by_domain[0]!.method).toBe("one_click");
  });

  it("URL+mailto without one-click post header → method=url (URL preferred)", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>, <mailto:u@a.com>",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: false,
        dry_run: true,
        confirm: false,
      },
      context,
    );

    expect(result.by_domain[0]!.method).toBe("url");
  });

  it("mailto only → method=mailto", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@b.com",
        listUnsub: "<mailto:unsub@b.com>",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:b.com",
        max: 20,
        archive_after: false,
        dry_run: true,
        confirm: false,
      },
      context,
    );

    expect(result.by_domain[0]!.method).toBe("mailto");
  });

  it("no List-Unsubscribe header → method=none, attempted=false", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({ id: "m1", from: "noreply@c.com" }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:c.com",
        max: 20,
        archive_after: false,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    const entry = result.by_domain[0]!;
    expect(entry.method).toBe("none");
    expect(entry.attempted).toBe(false);
    expect(entry.success).toBe(false);
  });

  it("one_click POST: fetch called with method=POST, body 'List-Unsubscribe=One-Click', form content-type, 2xx → success", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>",
        listUnsubPost: "List-Unsubscribe=One-Click",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: false,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("https://a.com/u");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("List-Unsubscribe=One-Click");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(result.by_domain[0]!.success).toBe(true);
    expect(result.by_domain[0]!.attempted).toBe(true);
  });

  it("URL GET method: fetch called with method=GET, 200 → success=true", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: false,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("https://a.com/u");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(result.by_domain[0]!.success).toBe(true);
  });

  it("mailto method: client.sendMessage called with raw MIME including To: <mailto-address>, default subject 'unsubscribe'", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@b.com",
        listUnsub: "<mailto:unsub@b.com>",
      }),
    );
    client.sendMessage.mockResolvedValue({
      id: "sent_1",
      threadId: "thr_sent_1",
      labelIds: ["SENT"],
    });

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:b.com",
        max: 20,
        archive_after: false,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const [acct, raw] = client.sendMessage.mock.calls[0]!;
    expect(acct).toBe("alice");
    const decoded = Buffer.from(raw as string, "base64url").toString("utf8");
    expect(decoded).toContain("To: unsub@b.com");
    expect(decoded).toContain("Subject: unsubscribe");
    expect(result.by_domain[0]!.success).toBe(true);
  });

  it("mailto with ?subject=foo&body=bar params honored", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@b.com",
        listUnsub: "<mailto:unsub@b.com?subject=Please%20unsubscribe%20me&body=Stop>",
      }),
    );
    client.sendMessage.mockResolvedValue({
      id: "sent_1",
      threadId: "thr_sent_1",
      labelIds: ["SENT"],
    });

    await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:b.com",
        max: 20,
        archive_after: false,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    const raw = client.sendMessage.mock.calls[0]![1] as string;
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("Subject: Please unsubscribe me");
    expect(decoded).toContain("Stop");
  });

  it("fetch returns 500 → success=false, reason='500'", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("server error", { status: 500 }),
    );
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: true,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    const entry = result.by_domain[0]!;
    expect(entry.success).toBe(false);
    expect(entry.attempted).toBe(true);
    expect(entry.reason).toContain("500");
    expect(client.batchModify).not.toHaveBeenCalled();
    expect(result.archived_count).toBe(0);
  });

  it("fetch throws (network error) → success=false, reason captured", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: false,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    const entry = result.by_domain[0]!;
    expect(entry.success).toBe(false);
    expect(entry.reason).toContain("ECONNREFUSED");
  });

  it("archive_after=true: after success, batchModify removeLabelIds=['INBOX'] called for domain ids", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a: string, id: string) =>
      makeMessageRaw({
        id,
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>",
      }),
    );
    client.batchModify.mockResolvedValue(undefined);

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: true,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(client.batchModify).toHaveBeenCalledWith("alice", {
      ids: ["m1", "m2"],
      removeLabelIds: ["INBOX"],
    });
    expect(result.archived_count).toBe(2);
  });

  it("archive_after=false: batchModify NOT called, archived_count=0", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: false,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(client.batchModify).not.toHaveBeenCalled();
    expect(result.archived_count).toBe(0);
    expect(result.by_domain[0]!.success).toBe(true);
  });

  it("groups by domain: 5 messages from same @spammy.com → one entry with message_count=5", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
        { id: "m3", threadId: "t3" },
        { id: "m4", threadId: "t4" },
        { id: "m5", threadId: "t5" },
      ],
      resultSizeEstimate: 5,
    });
    client.getMessage.mockImplementation(async (_a: string, id: string) =>
      makeMessageRaw({
        id,
        from: `Spammy <noreply-${id}@spammy.com>`,
        subject: `subj-${id}`,
        listUnsub: "<https://spammy.com/unsub>",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:spammy.com",
        max: 20,
        archive_after: false,
        dry_run: true,
        confirm: false,
      },
      context,
    );

    expect(result.by_domain).toHaveLength(1);
    const entry = result.by_domain[0]!;
    expect(entry.from_domain).toBe("spammy.com");
    expect(entry.message_count).toBe(5);
    expect(entry.message_ids).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(entry.sample_subjects).toHaveLength(3);
  });

  it("SMTP transport identity → ValidationError before any operation", async () => {
    writeIdentity(tmpHome, "alice", aliceSmtpIdentity());
    fetchSpy = vi.spyOn(globalThis, "fetch");
    const { context, client } = makeContext();

    await expect(
      bulkUnsubscribe.handler(
        {
          account: "alice",
          q: "from:spammy.com",
          max: 20,
          archive_after: true,
          dry_run: true,
          confirm: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.listMessages).not.toHaveBeenCalled();
  });

  it("per-domain failure resilience: domain A 500s, domain B succeeds; both surfaced; only B archived", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("a.com")) return new Response("", { status: 500 });
        return new Response("", { status: 200 });
      });
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a: string, id: string) => {
      if (id === "m1")
        return makeMessageRaw({
          id,
          from: "noreply@a.com",
          listUnsub: "<https://a.com/u>",
        });
      return makeMessageRaw({
        id,
        from: "noreply@b.com",
        listUnsub: "<https://b.com/u>",
      });
    });
    client.batchModify.mockResolvedValue(undefined);

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "spam",
        max: 20,
        archive_after: true,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(result.by_domain).toHaveLength(2);
    const a = result.by_domain.find((d) => d.from_domain === "a.com")!;
    const b = result.by_domain.find((d) => d.from_domain === "b.com")!;
    expect(a.success).toBe(false);
    expect(b.success).toBe(true);
    expect(result.archived_count).toBe(1);
    expect(client.batchModify).toHaveBeenCalledTimes(1);
    expect(client.batchModify).toHaveBeenCalledWith("alice", {
      ids: ["m2"],
      removeLabelIds: ["INBOX"],
    });
  });

  it("List-Unsubscribe-Post case-insensitive 'list-unsubscribe=one-click' → method=one_click", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>",
        listUnsubPost: "list-unsubscribe=one-click",
      }),
    );

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: false,
        dry_run: true,
        confirm: false,
      },
      context,
    );

    expect(result.by_domain[0]!.method).toBe("one_click");
  });

  it("archive failure does not abort the operation; success still recorded", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(
      makeMessageRaw({
        id: "m1",
        from: "noreply@a.com",
        listUnsub: "<https://a.com/u>",
      }),
    );
    client.batchModify.mockRejectedValue(new Error("archive boom"));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await bulkUnsubscribe.handler(
      {
        account: "alice",
        q: "from:a.com",
        max: 20,
        archive_after: true,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(result.by_domain[0]!.success).toBe(true);
    // batchModify failure is logged but not fatal — archived_count not bumped
    expect(result.archived_count).toBe(0);
    errSpy.mockRestore();
  });
});
