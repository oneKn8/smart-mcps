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
  NotFoundError,
  ValidationError,
} from "smart-mcp-core";
import { sendWithTemplate } from "../tools/send-template.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-tpl-tool-test-"));
}

function writeIdentity(home: string, account: string, body: string): void {
  const dir = path.join(home, ".santo-agent", "identities");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${account}.yaml`), body);
}

function writeTemplate(home: string, name: string, body: string): void {
  const dir = path.join(home, ".santo-agent", "templates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), body);
}

function aliceIdentity(): string {
  return [
    "account: alice",
    "email: alice@example.com",
    "display_name: Alice Example",
    "signature_html: \"<b>Alice</b>\"",
    "default_footer: Sent via santo-agent",
  ].join("\n");
}

function minimalTemplate(): string {
  // mirrors the real ~/.santo-agent/templates/email-base.html variable set
  return [
    "<title>{{TITLE}}</title>",
    "<div>{{PREHEADER}}</div>",
    "<div>From {{SENDER_NAME}}</div>",
    "<div>{{BODY_HTML}}</div>",
    "<div>{{SIGNATURE_HTML}}</div>",
    "<div>{{FOOTER_LINE}}</div>",
  ].join("\n");
}

function auditPath(home: string): string {
  return path.join(home, ".santo-agent", "audit", "send-log.jsonl");
}

function makeFakeClient(): {
  client: EmailClient;
  sendMock: ReturnType<typeof vi.fn>;
} {
  const sendMock = vi.fn(async () => ({
    id: "msg_tpl",
    threadId: "thr_tpl",
    labelIds: ["SENT"],
  }));
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

describe("send_with_template — metadata", () => {
  it("has expected name and description", () => {
    expect(sendWithTemplate.name).toBe("send_with_template");
    expect(sendWithTemplate.description).toBe(
      "Send templated HTML email with variable substitution.",
    );
  });
});

describe("send_with_template — input validation", () => {
  it("throws ValidationError before the gate when vars.body is missing", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendWithTemplate.handler(
        sendWithTemplate.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Hi",
          vars: { intro: "no body here" },
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("vars.body"),
    });

    expect(sendMock).not.toHaveBeenCalled();
    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });
});

describe("send_with_template — confirm gate", () => {
  it("throws ConfirmRequiredError by default; never calls sendMessage; never writes audit", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendWithTemplate.handler(
        sendWithTemplate.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          subject: "Hi",
          vars: { body: "<p>hello</p>" },
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);

    expect(sendMock).not.toHaveBeenCalled();
    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });

  it("preview format mirrors send_email", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    try {
      await sendWithTemplate.handler(
        sendWithTemplate.inputSchema.parse({
          account: "alice",
          to: "bob@example.com",
          cc: "carol@example.com",
          subject: "Quarterly review",
          vars: { body: "<p>x</p>" },
        }) as never,
        ctx as never,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        'Will send to bob@example.com from Alice Example <alice@example.com>: "Quarterly review" (cc: carol@example.com)',
      );
    }
  });
});

describe("send_with_template — identity errors", () => {
  it("throws NotFoundError when identity file is missing", async () => {
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendWithTemplate.handler(
        sendWithTemplate.inputSchema.parse({
          account: "ghost",
          to: "bob@example.com",
          subject: "Hi",
          vars: { body: "<p>x</p>" },
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects accounts with transport=smtp before any side effect", async () => {
    const smtpIdentity = [
      "account: utd",
      "email: utd@example.com",
      "display_name: UTD",
      "transport: smtp",
    ].join("\n");
    writeIdentity(tmpHome, "utd", smtpIdentity);
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendWithTemplate.handler(
        sendWithTemplate.inputSchema.parse({
          account: "utd",
          to: "bob@example.com",
          subject: "Hi",
          vars: { body: "<p>x</p>" },
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

describe("send_with_template — template errors", () => {
  it("throws NotFoundError when the template file is missing", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      sendWithTemplate.handler(
        sendWithTemplate.inputSchema.parse({
          account: "alice",
          template: "no-such-template",
          to: "bob@example.com",
          subject: "Hi",
          vars: { body: "<p>x</p>" },
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("send_with_template — render and send", () => {
  it("injects identity.signature_html into rendered body", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await sendWithTemplate.handler(
      sendWithTemplate.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Hi",
        vars: { body: "<p>HELLO</p>" },
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    // identity.signature_html is "<b>Alice</b>" — must appear in the html part
    expect(decoded).toContain("<b>Alice</b>");
    // body var substitution
    expect(decoded).toContain("<p>HELLO</p>");
    // identity-driven sender name + footer
    expect(decoded).toContain("From Alice Example");
    expect(decoded).toContain("Sent via santo-agent");
  });

  it("derives the multipart text part from the rendered HTML when text_override omitted", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await sendWithTemplate.handler(
      sendWithTemplate.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Hi",
        vars: { body: "<p>UNIQUE-BODY-MARKER</p>" },
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    // text/plain part appears before text/html in multipart/alternative
    const plainIdx = decoded.indexOf("text/plain");
    const htmlIdx = decoded.indexOf("text/html");
    expect(plainIdx).toBeGreaterThan(-1);
    expect(htmlIdx).toBeGreaterThan(plainIdx);
    // the derived text should contain the marker stripped of <p> tags
    const textPart = decoded.slice(plainIdx, htmlIdx);
    expect(textPart).toContain("UNIQUE-BODY-MARKER");
    expect(textPart).not.toContain("<p>");
  });

  it("uses text_override verbatim when provided", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await sendWithTemplate.handler(
      sendWithTemplate.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Hi",
        vars: { body: "<p>html-body</p>" },
        text_override: "CUSTOM-PLAIN-TEXT-MARKER",
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    const plainIdx = decoded.indexOf("text/plain");
    const htmlIdx = decoded.indexOf("text/html");
    const textPart = decoded.slice(plainIdx, htmlIdx);
    expect(textPart).toContain("CUSTOM-PLAIN-TEXT-MARKER");
    // ensure the html-derived content did NOT replace the override
    expect(textPart).not.toContain("html-body");
  });

  it("appends one audit entry on success with same ts as sent_at", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await sendWithTemplate.handler(
      sendWithTemplate.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Sync",
        vars: { body: "<p>Sync</p>" },
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
      subject: "Sync",
      gmail_id: "msg_tpl",
      gmail_thread_id: "thr_tpl",
    });
  });

  it("falls back to subject when vars.preheader not provided (TITLE substitution works)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    writeTemplate(tmpHome, "email-base", minimalTemplate());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await sendWithTemplate.handler(
      sendWithTemplate.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "MY-SUBJECT",
        vars: { body: "<p>x</p>" },
        confirm: true,
      }) as never,
      ctx as never,
    );

    const [, raw] = sendMock.mock.calls[0] as [string, string];
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("<title>MY-SUBJECT</title>");
  });
});
