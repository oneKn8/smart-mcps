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
import { z } from "zod";
import { bulkSend } from "../tools/bulk-send.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";
import * as auditModule from "../audit.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-bulk-send-test-"));
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
  let counter = 0;
  const sendMock = vi.fn(
    sendImpl ??
      (async () => {
        counter += 1;
        return {
          id: `msg_${counter}`,
          threadId: `thr_${counter}`,
          labelIds: ["SENT"],
        };
      }),
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
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("bulk_send — metadata", () => {
  it("has expected name and description", () => {
    expect(bulkSend.name).toBe("bulk_send");
    expect(typeof bulkSend.description).toBe("string");
    expect(bulkSend.description.length).toBeGreaterThan(0);
  });
});

describe("bulk_send — dry_run", () => {
  it("returns attempted=N with empty sent/failed; no sendMessage call; no audit file", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await bulkSend.handler(
      bulkSend.inputSchema.parse({
        account: "alice",
        recipients: [
          { to: "a@example.com" },
          { to: "b@example.com" },
          { to: "c@example.com" },
        ],
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
      }) as never,
      ctx as never,
    );

    expect(result).toEqual({
      attempted: 3,
      sent: [],
      failed: [],
      dry_run: true,
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });

  it("dry_run wins over confirm: dry_run=true + confirm=true still previews only", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await bulkSend.handler(
      bulkSend.inputSchema.parse({
        account: "alice",
        recipients: [{ to: "a@example.com" }],
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
        dry_run: true,
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(result.dry_run).toBe(true);
    expect(result.sent).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("bulk_send — confirm gate", () => {
  it("throws ConfirmRequiredError on dry_run=false + confirm=false; no side effects", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      bulkSend.handler(
        bulkSend.inputSchema.parse({
          account: "alice",
          recipients: [
            { to: "a@example.com" },
            { to: "b@example.com" },
          ],
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          dry_run: false,
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);

    expect(sendMock).not.toHaveBeenCalled();
    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });

  it("preview includes recipient count, identity, subject, rate_limit_ms, and first 3 recipients", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    try {
      await bulkSend.handler(
        bulkSend.inputSchema.parse({
          account: "alice",
          recipients: [
            { to: "a@example.com" },
            { to: "b@example.com" },
            { to: "c@example.com" },
            { to: "d@example.com" },
          ],
          subject: "Quarterly review",
          html: "<p>x</p>",
          text: "x",
          rate_limit_ms: 250,
          dry_run: false,
        }) as never,
        ctx as never,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("4 recipients");
      expect(preview).toContain("Alice Example <alice@example.com>");
      expect(preview).toContain('"Quarterly review"');
      expect(preview).toContain("rate limit: 250ms");
      expect(preview).toContain(
        "first 3: a@example.com, b@example.com, c@example.com",
      );
    }
  });
});

describe("bulk_send — happy path", () => {
  it("sends sequentially to all recipients; returns sent[] with gmail ids; appends N audit rows", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await bulkSend.handler(
      bulkSend.inputSchema.parse({
        account: "alice",
        recipients: [
          { to: "a@example.com" },
          { to: "b@example.com" },
          { to: "c@example.com" },
        ],
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
        rate_limit_ms: 0,
        dry_run: false,
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(result.attempted).toBe(3);
    expect(result.dry_run).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.sent).toHaveLength(3);
    expect(result.sent.map((s) => s.to)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(result.sent[0]!.gmail_id).toBe("msg_1");
    expect(result.sent[0]!.thread_id).toBe("thr_1");
    expect(result.sent[2]!.gmail_id).toBe("msg_3");

    const lines = fs
      .readFileSync(auditPath(tmpHome), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
  });

  it("substitutes per-recipient vars into subject/html/text; raw MIME contains correct values per recipient", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await bulkSend.handler(
      bulkSend.inputSchema.parse({
        account: "alice",
        recipients: [
          { to: "a@example.com", vars: { name: "Alice" } },
          { to: "b@example.com", vars: { name: "Bob" } },
        ],
        subject: "Hello {{name}}",
        html: "<p>Hi {{name}}</p>",
        text: "Hi {{name}}",
        rate_limit_ms: 0,
        dry_run: false,
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    const [, raw0] = sendMock.mock.calls[0] as [string, string];
    const [, raw1] = sendMock.mock.calls[1] as [string, string];
    const decoded0 = Buffer.from(raw0, "base64url").toString("utf-8");
    const decoded1 = Buffer.from(raw1, "base64url").toString("utf-8");

    expect(decoded0).toContain("Subject: Hello Alice");
    expect(decoded0).toContain("Hi Alice");
    expect(decoded0).not.toContain("Hello Bob");
    expect(decoded0).not.toContain("Hi Bob");

    expect(decoded1).toContain("Subject: Hello Bob");
    expect(decoded1).toContain("Hi Bob");
    // Identity "Alice Example" appears in the From header by design; check
    // that the body/subject substitutions did NOT carry over from recipient 0.
    expect(decoded1).not.toContain("Hello Alice");
    expect(decoded1).not.toContain("Hi Alice");
  });
});

describe("bulk_send — partial failure resilience", () => {
  it("missing var on one recipient: others succeed; failed[] entry has reason mentioning the variable", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await bulkSend.handler(
      bulkSend.inputSchema.parse({
        account: "alice",
        recipients: [
          { to: "a@example.com", vars: { name: "Alice" } },
          { to: "b@example.com" },
          { to: "c@example.com", vars: { name: "Carol" } },
        ],
        subject: "Hello {{name}}",
        html: "<p>Hi {{name}}</p>",
        text: "Hi {{name}}",
        rate_limit_ms: 0,
        dry_run: false,
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(result.attempted).toBe(3);
    expect(result.sent).toHaveLength(2);
    expect(result.sent.map((s) => s.to).sort()).toEqual([
      "a@example.com",
      "c@example.com",
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.to).toBe("b@example.com");
    expect(result.failed[0]!.reason).toContain("name");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("sendMessage error on one recipient: others still proceed; failed[] entry has the error message", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    let n = 0;
    const { client, sendMock } = makeFakeClient(async () => {
      n += 1;
      if (n === 2) throw new Error("upstream 503");
      return {
        id: `msg_${n}`,
        threadId: `thr_${n}`,
        labelIds: ["SENT"],
      };
    });
    const ctx = buildContext(client, tmpHome);

    const result = await bulkSend.handler(
      bulkSend.inputSchema.parse({
        account: "alice",
        recipients: [
          { to: "a@example.com" },
          { to: "b@example.com" },
          { to: "c@example.com" },
        ],
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
        rate_limit_ms: 0,
        dry_run: false,
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(result.sent).toHaveLength(2);
    expect(result.sent.map((s) => s.to)).toEqual([
      "a@example.com",
      "c@example.com",
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.to).toBe("b@example.com");
    expect(result.failed[0]!.reason).toContain("upstream 503");
  });

  it("audit append failure does NOT push recipient to failed[] (email DID get sent)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const appendSpy = vi
      .spyOn(auditModule, "appendAudit")
      .mockImplementation(() => {
        throw new Error("ENOSPC: disk full");
      });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await bulkSend.handler(
        bulkSend.inputSchema.parse({
          account: "alice",
          recipients: [{ to: "a@example.com" }, { to: "b@example.com" }],
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          rate_limit_ms: 0,
          dry_run: false,
          confirm: true,
        }) as never,
        ctx as never,
      );

      expect(result.sent).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      appendSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe("bulk_send — rate limit", () => {
  it("calls setTimeout once with rate_limit_ms between each pair (N-1 times)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    try {
      await bulkSend.handler(
        bulkSend.inputSchema.parse({
          account: "alice",
          recipients: [
            { to: "a@example.com" },
            { to: "b@example.com" },
            { to: "c@example.com" },
          ],
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          rate_limit_ms: 100,
          dry_run: false,
          confirm: true,
        }) as never,
        ctx as never,
      );

      const delayCalls = setTimeoutSpy.mock.calls.filter(
        (c) => c[1] === 100,
      );
      expect(delayCalls).toHaveLength(2);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("rate_limit_ms=0 skips sleep entirely (no setTimeout call with 0)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    try {
      await bulkSend.handler(
        bulkSend.inputSchema.parse({
          account: "alice",
          recipients: [
            { to: "a@example.com" },
            { to: "b@example.com" },
            { to: "c@example.com" },
          ],
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          rate_limit_ms: 0,
          dry_run: false,
          confirm: true,
        }) as never,
        ctx as never,
      );

      const zeroDelayCalls = setTimeoutSpy.mock.calls.filter(
        (c) => c[1] === 0,
      );
      expect(zeroDelayCalls).toHaveLength(0);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("bulk_send — validation", () => {
  it("throws ValidationError on duplicate recipient before any send", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      bulkSend.handler(
        bulkSend.inputSchema.parse({
          account: "alice",
          recipients: [
            { to: "a@example.com" },
            { to: "b@example.com" },
            { to: "a@example.com" },
          ],
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          dry_run: false,
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringMatching(/duplicate recipient.*a@example\.com/),
    });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects SMTP transport before any send", async () => {
    const smtpIdentity = [
      "account: utd",
      "email: utd@example.com",
      "display_name: UTD",
      "transport: smtp",
    ].join("\n");
    writeIdentity(tmpHome, "utd", smtpIdentity);
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    await expect(
      bulkSend.handler(
        bulkSend.inputSchema.parse({
          account: "utd",
          recipients: [{ to: "a@example.com" }],
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
          dry_run: false,
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringMatching(/smtp.*oauth only/s),
    });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects 51 recipients at the zod parse layer", () => {
    const recipients = Array.from({ length: 51 }, (_, i) => ({
      to: `r${i}@example.com`,
    }));
    expect(() =>
      bulkSend.inputSchema.parse({
        account: "alice",
        recipients,
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
      }),
    ).toThrow(z.ZodError);
  });

  it("empty vars per recipient: works when template has no vars", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const { client, sendMock } = makeFakeClient();
    const ctx = buildContext(client, tmpHome);

    const result = await bulkSend.handler(
      bulkSend.inputSchema.parse({
        account: "alice",
        recipients: [{ to: "a@example.com" }, { to: "b@example.com" }],
        subject: "Static",
        html: "<p>Static</p>",
        text: "Static",
        rate_limit_ms: 0,
        dry_run: false,
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(result.sent).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });
});

// Suppress unused import warning on ValidationError (used via toMatchObject).
void ValidationError;
