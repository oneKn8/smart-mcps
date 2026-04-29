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
import { sendWithAttachment } from "../tools/send-attachment.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-att-test-"));
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

function writeFixture(home: string, name: string, content: Buffer): string {
  const dir = path.join(home, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
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

describe("send_with_attachment — metadata", () => {
  it("has expected name and short description", () => {
    expect(sendWithAttachment.name).toBe("send_with_attachment");
    expect(typeof sendWithAttachment.description).toBe("string");
    expect(sendWithAttachment.description.length).toBeGreaterThan(0);
  });
});

describe("send_with_attachment — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is omitted; never reads files; never sends", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    // Note: NO file written at this path. If the tool reads the file before the
    // confirm gate, it will throw ENOENT instead of ConfirmRequiredError.
    const filePath = path.join(tmpHome, "fixtures", "missing.pdf");
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendWithAttachment.handler(
        sendWithAttachment.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          attachments: [{ filename: "x.pdf", path: filePath }],
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);

    expect(sendMock).not.toHaveBeenCalled();
    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });

  it("preview text mentions attachment count", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fp = writeFixture(tmpHome, "a.pdf", Buffer.from("PDFDATA"));
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    try {
      await sendWithAttachment.handler(
        sendWithAttachment.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Quarterly review",
          html: "<p>x</p>",
          text: "x",
          attachments: [{ filename: "a.pdf", path: fp }],
        }) as never,
        ctx as never,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const e = err as ConfirmRequiredError;
      expect(e.preview).toContain("bob@example.com");
      expect(e.preview).toContain("Quarterly review");
      expect(e.preview).toContain("1 attachment");
    }
  });
});

describe("send_with_attachment — transport gate", () => {
  it("rejects accounts with transport=smtp before any file read", async () => {
    const smtp = [
      "account: utd",
      "email: utd@example.com",
      "display_name: UTD",
      "transport: smtp",
    ].join("\n");
    writeIdentity(tmpHome, "utd", smtp);
    // Path doesn't exist — if the tool reads first, we'd get ENOENT instead.
    const ghost = path.join(tmpHome, "ghost.pdf");
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendWithAttachment.handler(
        sendWithAttachment.inputSchema.parse({
          account: "utd",
          to: "bob@example.com",
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          attachments: [{ filename: "g.pdf", path: ghost }],
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringMatching(/smtp.*oauth only/s),
    });

    expect(sendMock).not.toHaveBeenCalled();
    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });
});

describe("send_with_attachment — happy path (path form)", () => {
  it("reads file from disk, sends, returns gmail_id and attachment_count=1", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fp = writeFixture(tmpHome, "doc.pdf", Buffer.from("PDFCONTENT"));
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await sendWithAttachment.handler(
      sendWithAttachment.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
        attachments: [{ filename: "doc.pdf", path: fp }],
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [account, raw] = sendMock.mock.calls[0] as [string, string];
    expect(account).toBe("alice");
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("multipart/mixed");
    expect(decoded).toContain('filename="doc.pdf"');
    expect(decoded).toContain("Content-Type: application/pdf");

    expect(result).toEqual({
      gmail_id: "msg_abc",
      thread_id: "thr_xyz",
      from: "Alice Example <alice@example.com>",
      to: "bob@example.com",
      subject: "Hi",
      sent_at: "2026-04-28T12:00:00.000Z",
      attachment_count: 1,
    });
  });
});

describe("send_with_attachment — happy path (data form)", () => {
  it("decodes base64 data and sends without touching disk", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);
    const payload = Buffer.from("inline data payload");
    const data = payload.toString("base64");

    const result = await sendWithAttachment.handler(
      sendWithAttachment.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Inline",
        html: "<p>x</p>",
        text: "x",
        attachments: [
          { filename: "inline.txt", data, content_type: "text/plain; charset=utf-8" },
        ],
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain('filename="inline.txt"');
    // The base64 encoding of "inline data payload" should appear in the body
    // (compact, no whitespace, since payload is short).
    expect(decoded).toContain(payload.toString("base64"));
    expect(result.attachment_count).toBe(1);
  });
});

describe("send_with_attachment — multiple attachments", () => {
  it("sends all attachments in one MIME, attachment_count matches", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const a = writeFixture(tmpHome, "a.txt", Buffer.from("A"));
    const b = writeFixture(tmpHome, "b.png", Buffer.from("B"));
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await sendWithAttachment.handler(
      sendWithAttachment.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Multi",
        html: "<p>x</p>",
        text: "x",
        attachments: [
          { filename: "a.txt", path: a },
          { filename: "b.png", path: b },
          { filename: "c.json", data: Buffer.from('{"k":1}').toString("base64") },
        ],
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(result.attachment_count).toBe(3);
    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain('filename="a.txt"');
    expect(decoded).toContain('filename="b.png"');
    expect(decoded).toContain('filename="c.json"');
    // c.json content_type inferred from extension.
    expect(decoded).toContain("application/json; charset=utf-8");
  });
});

describe("send_with_attachment — size cap", () => {
  it("rejects when combined attachment size exceeds 25MB before sending", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    // Build a 13MB + 13MB pair = 26MB combined via base64 (pre-encoding bytes).
    const big = Buffer.alloc(13 * 1024 * 1024, 0x41); // 13MB of 'A'
    const data = big.toString("base64");
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendWithAttachment.handler(
        sendWithAttachment.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Big",
          html: "<p>x</p>",
          text: "x",
          attachments: [
            { filename: "one.bin", data },
            { filename: "two.bin", data },
          ],
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("25MB"),
    });

    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("send_with_attachment — content_type inference", () => {
  it("infers application/pdf, image/png, application/json, fallback application/octet-stream", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const pdf = writeFixture(tmpHome, "doc.pdf", Buffer.from("PDF"));
    const png = writeFixture(tmpHome, "pic.png", Buffer.from("PNG"));
    const json = writeFixture(tmpHome, "d.json", Buffer.from("{}"));
    const unknown = writeFixture(tmpHome, "weird.xyz", Buffer.from("?"));
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await sendWithAttachment.handler(
      sendWithAttachment.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Types",
        html: "<p>x</p>",
        text: "x",
        attachments: [
          { filename: "doc.pdf", path: pdf },
          { filename: "pic.png", path: png },
          { filename: "d.json", path: json },
          { filename: "weird.xyz", path: unknown },
        ],
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("application/pdf");
    expect(decoded).toContain("image/png");
    expect(decoded).toContain("application/json; charset=utf-8");
    expect(decoded).toContain("application/octet-stream");
  });
});

describe("send_with_attachment — non-ASCII filename rejected", () => {
  it("throws ValidationError when filename contains non-ASCII characters", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendWithAttachment.handler(
        sendWithAttachment.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Hi",
          html: "<p>x</p>",
          text: "x",
          attachments: [
            { filename: "résumé.pdf", data: Buffer.from("X").toString("base64") },
          ],
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("send_with_attachment — audit log", () => {
  it("writes audit entry with attachment_count when set", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fp = writeFixture(tmpHome, "doc.pdf", Buffer.from("PDFCONTENT"));
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await sendWithAttachment.handler(
      sendWithAttachment.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        cc: "carol@example.com",
        subject: "Doc",
        html: "<p>x</p>",
        text: "x",
        attachments: [{ filename: "doc.pdf", path: fp }],
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
    expect(entry.account).toBe("alice");
    expect(entry.to).toBe("bob@example.com");
    expect(entry.cc).toBe("carol@example.com");
    expect(entry.subject).toBe("Doc");
    expect(entry.gmail_id).toBe("msg_abc");
    expect(entry.attachment_count).toBe(1);
  });
});
