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
import {
  ConfirmRequiredError,
  ValidationError,
} from "smart-mcp-core";
import { composeThread } from "../tools/compose-thread.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-thread-test-"));
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

function auditPath(home: string): string {
  return path.join(home, ".santo-agent", "audit", "send-log.jsonl");
}

type Header = { name: string; value: string };

function makeOriginal(opts: {
  id?: string;
  threadId?: string;
  headers?: Header[];
}): Record<string, unknown> {
  return {
    id: opts.id ?? "orig_msg_1",
    threadId: opts.threadId ?? "thr_orig",
    payload: {
      headers: opts.headers ?? [],
    },
  };
}

function makeFakeClient(opts: {
  getMessageImpl?: (
    account: string,
    id: string,
    format?: string,
  ) => Promise<unknown>;
  sendImpl?: (
    account: string,
    raw: string,
  ) => Promise<{ id: string; threadId: string; labelIds: string[] }>;
}): {
  client: EmailClient;
  getMock: ReturnType<typeof vi.fn>;
  sendMock: ReturnType<typeof vi.fn>;
} {
  const getMock = vi.fn(
    opts.getMessageImpl ??
      (async () =>
        makeOriginal({
          headers: [
            { name: "Message-ID", value: "<orig-id@mail.gmail.com>" },
            { name: "From", value: "Bob <bob@example.com>" },
            { name: "Subject", value: "Hello" },
          ],
        })),
  );
  const sendMock = vi.fn(
    opts.sendImpl ??
      (async () => ({
        id: "msg_new",
        threadId: "thr_orig",
        labelIds: ["SENT"],
      })),
  );
  const client = {
    getMessage: getMock,
    sendMessage: sendMock,
  } as unknown as EmailClient;
  return { client, getMock, sendMock };
}

function buildContext(client: EmailClient, home: string): EmailContext {
  return { client, home } as unknown as EmailContext;
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

describe("compose_thread — metadata", () => {
  it("has expected name and description", () => {
    expect(composeThread.name).toBe("compose_thread");
    expect(typeof composeThread.description).toBe("string");
    expect(composeThread.description.length).toBeGreaterThan(0);
  });
});

describe("compose_thread — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm omitted; never calls getMessage or sendMessage", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, getMock, sendMock } = makeFakeClient({});
    const ctx = buildContext(client, tmpHome);

    await expect(
      composeThread.handler(
        composeThread.inputSchema.parse({
          account: "alice",
          in_reply_to_id: "orig_msg_1",
          html: "<p>Reply</p>",
          text: "Reply",
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);

    // Confirm gate must fire BEFORE the Gmail GET so we don't waste API
    // calls on an unconfirmed reply. (We DO need identity loaded first to
    // shape the preview; but no network calls.)
    expect(getMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });
});

describe("compose_thread — transport gate", () => {
  it("rejects accounts with transport=smtp before any API call", async () => {
    const smtpIdentity = [
      "account: utd",
      "email: utd@example.com",
      "display_name: UTD",
      "transport: smtp",
    ].join("\n");
    writeIdentity(tmpHome, "utd", smtpIdentity);
    const { client, getMock, sendMock } = makeFakeClient({});
    const ctx = buildContext(client, tmpHome);

    await expect(
      composeThread.handler(
        composeThread.inputSchema.parse({
          account: "utd",
          in_reply_to_id: "orig_msg_1",
          html: "<p>x</p>",
          text: "x",
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringMatching(/smtp.*oauth only/s),
    });

    expect(getMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("compose_thread — header extraction + threading", () => {
  it("extracts Message-ID + Subject + From from original; builds Re: subject and to=parsed-email", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, getMock, sendMock } = makeFakeClient({});
    const ctx = buildContext(client, tmpHome);

    const result = await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        html: "<p>Reply body</p>",
        text: "Reply body",
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("alice", "orig_msg_1", "metadata");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [account, raw] = sendMock.mock.calls[0] as [string, string];
    expect(account).toBe("alice");
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");

    expect(decoded).toContain("In-Reply-To: <orig-id@mail.gmail.com>");
    expect(decoded).toContain("References: <orig-id@mail.gmail.com>");
    expect(decoded).toContain("Subject: Re: Hello");
    expect(decoded).toContain("To: bob@example.com");

    expect(result.thread_id).toBe("thr_orig");
    expect(result.gmail_id).toBe("msg_new");
    expect(result.subject).toBe("Re: Hello");
    expect(result.to).toBe("bob@example.com");
  });

  it("appends original Message-ID to existing References chain (space-separated)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient({
      getMessageImpl: async () =>
        makeOriginal({
          headers: [
            { name: "Message-ID", value: "<latest@mail.gmail.com>" },
            {
              name: "References",
              value: "<root@mail.gmail.com> <middle@mail.gmail.com>",
            },
            { name: "From", value: "bob@example.com" },
            { name: "Subject", value: "Re: Project" },
          ],
        }),
    });
    const ctx = buildContext(client, tmpHome);

    await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        html: "<p>x</p>",
        text: "x",
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain(
      "References: <root@mail.gmail.com> <middle@mail.gmail.com> <latest@mail.gmail.com>",
    );
    expect(decoded).toContain("In-Reply-To: <latest@mail.gmail.com>");
  });

  it("does not duplicate subject_prefix when original subject already starts with it (case-insensitive)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient({
      getMessageImpl: async () =>
        makeOriginal({
          headers: [
            { name: "Message-ID", value: "<x@mail.gmail.com>" },
            { name: "From", value: "bob@example.com" },
            { name: "Subject", value: "RE: yo" },
          ],
        }),
    });
    const ctx = buildContext(client, tmpHome);

    const result = await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        html: "<p>x</p>",
        text: "x",
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(result.subject).toBe("RE: yo");
    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("Subject: RE: yo");
    expect(decoded).not.toContain("Subject: Re: RE: yo");
  });

  it('subject_prefix="" preserves original subject as-is', async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient({
      getMessageImpl: async () =>
        makeOriginal({
          headers: [
            { name: "Message-ID", value: "<x@mail.gmail.com>" },
            { name: "From", value: "bob@example.com" },
            { name: "Subject", value: "Plain subject" },
          ],
        }),
    });
    const ctx = buildContext(client, tmpHome);

    const result = await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        subject_prefix: "",
        html: "<p>x</p>",
        text: "x",
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(result.subject).toBe("Plain subject");
    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("Subject: Plain subject");
  });

  it("input.to overrides parsed-From-header", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient({});
    const ctx = buildContext(client, tmpHome);

    await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        to: "override@example.com",
        html: "<p>x</p>",
        text: "x",
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("To: override@example.com");
    expect(decoded).not.toContain("To: bob@example.com");
  });

  it("wraps Message-ID without angle brackets in <...> for In-Reply-To and References", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient({
      getMessageImpl: async () =>
        makeOriginal({
          headers: [
            // Note: no angle brackets — RFC noncompliant but exists in the wild.
            { name: "Message-ID", value: "raw-id@mail.gmail.com" },
            { name: "From", value: "bob@example.com" },
            { name: "Subject", value: "Hi" },
          ],
        }),
    });
    const ctx = buildContext(client, tmpHome);

    await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        html: "<p>x</p>",
        text: "x",
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("In-Reply-To: <raw-id@mail.gmail.com>");
    expect(decoded).toContain("References: <raw-id@mail.gmail.com>");
  });

  it("Message-ID lookup is case-insensitive (matches Message-Id variant)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient({
      getMessageImpl: async () =>
        makeOriginal({
          headers: [
            { name: "Message-Id", value: "<lower@mail.gmail.com>" },
            { name: "from", value: "bob@example.com" },
            { name: "subject", value: "Hi" },
          ],
        }),
    });
    const ctx = buildContext(client, tmpHome);

    const result = await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        html: "<p>x</p>",
        text: "x",
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(result.subject).toBe("Re: Hi");
    expect(result.to).toBe("bob@example.com");
    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("In-Reply-To: <lower@mail.gmail.com>");
  });
});

describe("compose_thread — Message-ID missing", () => {
  it("throws ValidationError when original has no Message-ID header", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient({
      getMessageImpl: async () =>
        makeOriginal({
          id: "orig_msg_1",
          headers: [
            { name: "From", value: "bob@example.com" },
            { name: "Subject", value: "Hi" },
          ],
        }),
    });
    const ctx = buildContext(client, tmpHome);

    await expect(
      composeThread.handler(
        composeThread.inputSchema.parse({
          account: "alice",
          in_reply_to_id: "orig_msg_1",
          html: "<p>x</p>",
          text: "x",
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringMatching(/no Message-ID header.*cannot thread/),
    });

    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("compose_thread — happy path returns thread_id matching original", () => {
  it("returns the thread_id reported by sendMessage (Gmail decides actual threading)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient({
      sendImpl: async () => ({
        id: "msg_reply",
        threadId: "thr_orig",
        labelIds: ["SENT"],
      }),
    });
    const ctx = buildContext(client, tmpHome);

    const result = await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        html: "<p>x</p>",
        text: "x",
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(result.thread_id).toBe("thr_orig");
    expect(result.gmail_id).toBe("msg_reply");
    expect(result.from).toBe("Alice Example <alice@example.com>");
    expect(result.sent_at).toBe("2026-04-28T12:00:00.000Z");
  });

  it("appends one audit-log entry on success", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient({});
    const ctx = buildContext(client, tmpHome);

    const result = await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        html: "<p>x</p>",
        text: "x",
        confirm: true,
      }) as never,
      ctx as never,
    );

    const lines = fs
      .readFileSync(auditPath(tmpHome), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toEqual({
      ts: result.sent_at,
      account: "alice",
      to: "bob@example.com",
      cc: "",
      bcc: "",
      subject: "Re: Hello",
      gmail_id: "msg_new",
      gmail_thread_id: "thr_orig",
    });
  });
});

describe("compose_thread — preview", () => {
  it("preview text references in_reply_to_id and the new subject", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient({});
    const ctx = buildContext(client, tmpHome);

    try {
      await composeThread.handler(
        composeThread.inputSchema.parse({
          account: "alice",
          in_reply_to_id: "orig_msg_1",
          to: "explicit@example.com",
          html: "<p>x</p>",
          text: "x",
        }) as never,
        ctx as never,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("orig_msg_1");
      expect(preview).toContain("Alice Example <alice@example.com>");
      expect(preview).toContain("explicit@example.com");
    }
  });
});

describe("compose_thread — user headers override threading defaults", () => {
  it("user-provided In-Reply-To header wins over computed value", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient({});
    const ctx = buildContext(client, tmpHome);

    await composeThread.handler(
      composeThread.inputSchema.parse({
        account: "alice",
        in_reply_to_id: "orig_msg_1",
        html: "<p>x</p>",
        text: "x",
        headers: { "In-Reply-To": "<custom@override.com>" },
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("In-Reply-To: <custom@override.com>");
    expect(decoded).not.toContain("In-Reply-To: <orig-id@mail.gmail.com>");
  });
});

// Sanity: keep ValidationError exposed as a usable type for callers via the
// imports above. (Lint guard against unused import — a no-op assertion.)
describe("compose_thread — sanity", () => {
  it("ValidationError import wiring", () => {
    expect(typeof ValidationError).toBe("function");
  });
});
