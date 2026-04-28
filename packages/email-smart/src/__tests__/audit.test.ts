import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendAudit, readAudit, type AuditEntry } from "../audit.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-audit-test-"));
}

function auditPath(home: string): string {
  return path.join(home, ".santo-agent", "audit", "send-log.jsonl");
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

describe("appendAudit", () => {
  it("creates the audit directory and file when neither exists", () => {
    const entry: AuditEntry = {
      ts: "2026-04-28T12:00:00.000Z",
      account: "alice",
      to: "bob@example.com",
      subject: "Hi",
      gmail_id: "msg_abc",
      gmail_thread_id: "thr_xyz",
    };
    appendAudit(entry, tmpHome);
    expect(fs.existsSync(auditPath(tmpHome))).toBe(true);
    const lines = fs.readFileSync(auditPath(tmpHome), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("writes cc and bcc as empty strings when omitted (Python parity)", () => {
    appendAudit(
      {
        ts: "2026-04-28T12:00:00.000Z",
        account: "alice",
        to: "bob@example.com",
        subject: "Hi",
        gmail_id: "msg_abc",
        gmail_thread_id: "thr_xyz",
      },
      tmpHome,
    );
    const line = fs.readFileSync(auditPath(tmpHome), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.cc).toBe("");
    expect(parsed.bcc).toBe("");
  });

  it("preserves field order: ts, account, to, cc, bcc, subject, gmail_id, gmail_thread_id", () => {
    appendAudit(
      {
        ts: "2026-04-28T12:00:00.000Z",
        account: "alice",
        to: "bob@example.com",
        cc: "carol@example.com",
        bcc: "dan@example.com",
        subject: "Hi",
        gmail_id: "msg_abc",
        gmail_thread_id: "thr_xyz",
      },
      tmpHome,
    );
    const line = fs.readFileSync(auditPath(tmpHome), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed)).toEqual([
      "ts",
      "account",
      "to",
      "cc",
      "bcc",
      "subject",
      "gmail_id",
      "gmail_thread_id",
    ]);
  });

  it("appends rather than overwriting when called repeatedly", () => {
    for (let i = 0; i < 3; i++) {
      appendAudit(
        {
          ts: `2026-04-28T12:0${i}:00.000Z`,
          account: "alice",
          to: "bob@example.com",
          subject: `msg ${i}`,
          gmail_id: `msg_${i}`,
          gmail_thread_id: `thr_${i}`,
        },
        tmpHome,
      );
    }
    const lines = fs
      .readFileSync(auditPath(tmpHome), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
  });

  it("treats explicit undefined for cc/bcc as omitted (still writes empty strings)", () => {
    appendAudit(
      {
        ts: "2026-04-28T12:00:00.000Z",
        account: "alice",
        to: "bob@example.com",
        cc: undefined,
        bcc: undefined,
        subject: "Hi",
        gmail_id: "msg_abc",
        gmail_thread_id: "thr_xyz",
      },
      tmpHome,
    );
    const line = fs.readFileSync(auditPath(tmpHome), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.cc).toBe("");
    expect(parsed.bcc).toBe("");
  });
});

describe("readAudit", () => {
  it("returns empty array when no log file exists", () => {
    expect(readAudit(tmpHome)).toEqual([]);
  });

  it("parses an entry written by appendAudit (TS round-trip)", () => {
    const entry: AuditEntry = {
      ts: "2026-04-28T12:00:00.000Z",
      account: "alice",
      to: "bob@example.com",
      cc: "carol@example.com",
      bcc: "dan@example.com",
      subject: "Hi",
      gmail_id: "msg_abc",
      gmail_thread_id: "thr_xyz",
    };
    appendAudit(entry, tmpHome);
    const all = readAudit(tmpHome);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(entry);
  });

  it("round-trips a Python-produced entry verbatim (cc/bcc empty strings, +00:00 ISO)", () => {
    const dir = path.join(tmpHome, ".santo-agent", "audit");
    fs.mkdirSync(dir, { recursive: true });
    const pythonLine = JSON.stringify({
      ts: "2026-04-28T18:30:00+00:00",
      account: "alice",
      to: "bob@example.com",
      cc: "",
      bcc: "",
      subject: "Hi",
      gmail_id: "msg_abc",
      gmail_thread_id: "thr_xyz",
    });
    fs.writeFileSync(path.join(dir, "send-log.jsonl"), pythonLine + "\n");
    const all = readAudit(tmpHome);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      ts: "2026-04-28T18:30:00+00:00",
      account: "alice",
      to: "bob@example.com",
      cc: "",
      bcc: "",
      subject: "Hi",
      gmail_id: "msg_abc",
      gmail_thread_id: "thr_xyz",
    });
  });

  it("returns entries in append order across many writes", () => {
    for (let i = 0; i < 5; i++) {
      appendAudit(
        {
          ts: `2026-04-28T12:0${i}:00.000Z`,
          account: "alice",
          to: "bob@example.com",
          subject: `msg ${i}`,
          gmail_id: `msg_${i}`,
          gmail_thread_id: `thr_${i}`,
        },
        tmpHome,
      );
    }
    const all = readAudit(tmpHome);
    expect(all.map((e) => e.gmail_id)).toEqual([
      "msg_0",
      "msg_1",
      "msg_2",
      "msg_3",
      "msg_4",
    ]);
  });

  it("skips blank lines silently", () => {
    const dir = path.join(tmpHome, ".santo-agent", "audit");
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: "2026-04-28T12:00:00.000Z",
      account: "alice",
      to: "bob@example.com",
      cc: "",
      bcc: "",
      subject: "Hi",
      gmail_id: "msg_abc",
      gmail_thread_id: "thr_xyz",
    });
    fs.writeFileSync(
      path.join(dir, "send-log.jsonl"),
      "\n" + line + "\n\n",
    );
    expect(readAudit(tmpHome)).toHaveLength(1);
  });
});
