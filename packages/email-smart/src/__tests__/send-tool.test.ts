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
  AuthError,
  ConfirmRequiredError,
  NotFoundError,
  ValidationError,
} from "smart-mcp-core";
import { sendEmail } from "../tools/send.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-tool-test-"));
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

function makeFakeClient(
  sendImpl?: (
    account: string,
    raw: string,
  ) => Promise<{ id: string; threadId: string; labelIds: string[] }>,
): { client: EmailClient; sendMock: ReturnType<typeof vi.fn> } {
  const sendMock = vi.fn(
    sendImpl ??
      (async () => ({
        id: "msg_abc",
        threadId: "thr_xyz",
        labelIds: ["SENT"],
      })),
  );
  const client = { sendMessage: sendMock } as unknown as EmailClient;
  return { client, sendMock };
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

describe("send_email — metadata", () => {
  it("has expected name and description", () => {
    expect(sendEmail.name).toBe("send_email");
    expect(sendEmail.description).toBe(
      "Send HTML+text email via Gmail (multi-account).",
    );
  });
});

describe("send_email — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is omitted; never calls sendMessage; never writes audit", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendEmail.handler(
        sendEmail.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);

    expect(sendMock).not.toHaveBeenCalled();
    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });

  it("preview text uses exact format: Will send to <to> from <name> <<email>>: \"<subject>\"", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    try {
      await sendEmail.handler(
        sendEmail.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Quarterly review",
          html: "<p>x</p>",
          text: "x",
        }) as never,
        ctx as never,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        'Will send to bob@example.com from Alice Example <alice@example.com>: "Quarterly review"',
      );
    }
  });

  it("preview text appends cc and bcc when provided", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    try {
      await sendEmail.handler(
        sendEmail.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          cc: "carol@example.com",
          bcc: "dan@example.com",
          subject: "Q1",
          html: "<p>x</p>",
          text: "x",
        }) as never,
        ctx as never,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        'Will send to bob@example.com from Alice Example <alice@example.com>: "Q1" (cc: carol@example.com) (bcc: dan@example.com)',
      );
    }
  });
});

describe("send_email — identity errors", () => {
  it("throws NotFoundError when identity file is missing", async () => {
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);
    await expect(
      sendEmail.handler(
        sendEmail.inputSchema.parse({
          account: "ghost",
          to: "bob@example.com",
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("send_email — happy path", () => {
  it("calls client.sendMessage with base64url RAW and returns slim shape", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await sendEmail.handler(
      sendEmail.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [account, raw] = sendMock.mock.calls[0] as [string, string];
    expect(account).toBe("alice");
    // raw is base64url; decoding should yield a MIME body containing our subject + From.
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("From: Alice Example <alice@example.com>");
    expect(decoded).toContain("Subject: Hi");
    expect(decoded).toContain("To: bob@example.com");

    expect(result).toEqual({
      gmail_id: "msg_abc",
      thread_id: "thr_xyz",
      from: "Alice Example <alice@example.com>",
      to: "bob@example.com",
      subject: "Hi",
      sent_at: "2026-04-28T12:00:00.000Z",
    });
  });

  it("appends one audit-log entry on success with the same ts as sent_at", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await sendEmail.handler(
      sendEmail.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        cc: "carol@example.com",
        subject: "Sync",
        html: "<p>Sync</p>",
        text: "Sync",
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
      cc: "carol@example.com",
      bcc: "",
      subject: "Sync",
      gmail_id: "msg_abc",
      gmail_thread_id: "thr_xyz",
    });
  });
});

describe("send_email — failure path", () => {
  it("does NOT append audit entry when Gmail sendMessage rejects with ValidationError", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient(async () => {
      throw new ValidationError("POST gmail/send → 400");
    });
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendEmail.handler(
        sendEmail.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });

  it("propagates AuthError from sendMessage with 403 scope-insufficient text intact", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient(async () => {
      throw new AuthError(
        "scope insufficient for account alice — re-run python3 ~/.santo-agent/bin/auth.py --account alice after expanding scope to gmail.modify",
      );
    });
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendEmail.handler(
        sendEmail.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining(
        "after expanding scope to gmail.modify",
      ),
    });

    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });
});

describe("send_email — passes optional fields through to MIME builder", () => {
  it("includes Cc and Bcc headers in the raw bytes when provided", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await sendEmail.handler(
      sendEmail.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        cc: "carol@example.com",
        bcc: "dan@example.com",
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("Cc: carol@example.com");
    expect(decoded).toContain("Bcc: dan@example.com");
  });

  it("uses input.reply_to to set the Reply-To header when provided", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await sendEmail.handler(
      sendEmail.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
        reply_to: "support@example.com",
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("Reply-To: support@example.com");
  });
});
