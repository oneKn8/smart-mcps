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
import { ValidationError } from "smart-mcp-core";
import {
  listRecentSendsTool,
  searchAuditTool,
} from "../tools/audit.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-audit-tool-test-"));
}

function buildContext(home: string): EmailContext {
  const client = {} as unknown as EmailClient;
  return { client, home };
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

describe("list_recent_sends tool", () => {
  it("returns all entries newest-first by default", async () => {
    writeAudit(tmpHome, [
      row("2026-04-28T12:00:00.000Z", "alice", "a@x", "msg 0", "m0"),
      row("2026-04-28T12:01:00.000Z", "alice", "a@x", "msg 1", "m1"),
      row("2026-04-28T12:02:00.000Z", "bob", "b@x", "msg 2", "m2"),
      row("2026-04-28T12:03:00.000Z", "alice", "a@x", "msg 3", "m3"),
      row("2026-04-28T12:04:00.000Z", "bob", "b@x", "msg 4", "m4"),
    ]);
    const result = await listRecentSendsTool.handler(
      { limit: 20, offset: 0 },
      buildContext(tmpHome),
    );
    expect(result.total).toBe(5);
    expect(result.returned).toBe(5);
    expect(result.entries.map((e) => e.gmail_id)).toEqual([
      "m4",
      "m3",
      "m2",
      "m1",
      "m0",
    ]);
  });

  it("filters by account when provided", async () => {
    writeAudit(tmpHome, [
      row("2026-04-28T12:00:00.000Z", "alice", "a@x", "msg 0", "m0"),
      row("2026-04-28T12:01:00.000Z", "alice", "a@x", "msg 1", "m1"),
      row("2026-04-28T12:02:00.000Z", "bob", "b@x", "msg 2", "m2"),
      row("2026-04-28T12:03:00.000Z", "alice", "a@x", "msg 3", "m3"),
    ]);
    const result = await listRecentSendsTool.handler(
      { account: "alice", limit: 20, offset: 0 },
      buildContext(tmpHome),
    );
    expect(result.total).toBe(3);
    expect(result.returned).toBe(3);
    expect(result.entries.map((e) => e.gmail_id)).toEqual(["m3", "m1", "m0"]);
  });

  it("applies offset + limit and reports total before pagination", async () => {
    writeAudit(tmpHome, [
      row("2026-04-28T12:00:00.000Z", "alice", "a@x", "msg 0", "m0"),
      row("2026-04-28T12:01:00.000Z", "alice", "a@x", "msg 1", "m1"),
      row("2026-04-28T12:02:00.000Z", "alice", "a@x", "msg 2", "m2"),
      row("2026-04-28T12:03:00.000Z", "alice", "a@x", "msg 3", "m3"),
      row("2026-04-28T12:04:00.000Z", "alice", "a@x", "msg 4", "m4"),
    ]);
    const result = await listRecentSendsTool.handler(
      { limit: 2, offset: 1 },
      buildContext(tmpHome),
    );
    expect(result.total).toBe(5);
    expect(result.returned).toBe(2);
    // Newest-first => m4, m3, m2, m1, m0; offset 1 + limit 2 => m3, m2.
    expect(result.entries.map((e) => e.gmail_id)).toEqual(["m3", "m2"]);
  });

  it("returns empty result for missing log", async () => {
    const result = await listRecentSendsTool.handler(
      { limit: 20, offset: 0 },
      buildContext(tmpHome),
    );
    expect(result).toEqual({ entries: [], total: 0, returned: 0 });
  });
});

describe("search_audit tool", () => {
  function fixture(home: string): void {
    writeAudit(home, [
      row("2026-04-26T10:00:00.000Z", "alice", "bob@example.com", "Hello", "m0"),
      row("2026-04-27T10:00:00.000Z", "alice", "carol@example.com", "RE: Hello", "m1"),
      row("2026-04-28T10:00:00.000Z", "bob", "BOB@example.com", "Hi", "m2"),
      row("2026-04-29T10:00:00.000Z", "alice", "dan@example.com", "RE: Status", "m3"),
      row("2026-04-30T10:00:00.000Z", "bob", "eve@example.com", "Quarterly", "m4"),
    ]);
  }

  it("filters by to_contains case-insensitively", async () => {
    fixture(tmpHome);
    const result = await searchAuditTool.handler(
      { to_contains: "bob", limit: 50 },
      buildContext(tmpHome),
    );
    expect(result.matched).toBe(2);
    expect(result.entries.map((e) => e.gmail_id).sort()).toEqual(["m0", "m2"]);
  });

  it("filters by subject_contains case-insensitively", async () => {
    fixture(tmpHome);
    const result = await searchAuditTool.handler(
      { subject_contains: "RE:", limit: 50 },
      buildContext(tmpHome),
    );
    expect(result.matched).toBe(2);
    expect(result.entries.map((e) => e.gmail_id).sort()).toEqual(["m1", "m3"]);
  });

  it("filters by since (entries on or after the boundary)", async () => {
    fixture(tmpHome);
    const result = await searchAuditTool.handler(
      { since: "2026-04-28T00:00:00Z", limit: 50 },
      buildContext(tmpHome),
    );
    expect(result.matched).toBe(3);
    expect(result.entries.map((e) => e.gmail_id)).toEqual(["m4", "m3", "m2"]);
  });

  it("combines account + since + subject_contains with AND semantics", async () => {
    fixture(tmpHome);
    const result = await searchAuditTool.handler(
      {
        account: "alice",
        since: "2026-04-28T00:00:00Z",
        subject_contains: "RE:",
        limit: 50,
      },
      buildContext(tmpHome),
    );
    expect(result.matched).toBe(1);
    expect(result.entries.map((e) => e.gmail_id)).toEqual(["m3"]);
  });

  it("throws ValidationError when since is not parseable ISO", async () => {
    fixture(tmpHome);
    await expect(
      searchAuditTool.handler(
        { since: "not-a-date", limit: 50 },
        buildContext(tmpHome),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("filters by until (entries on or before the boundary)", async () => {
    fixture(tmpHome);
    const result = await searchAuditTool.handler(
      { until: "2026-04-27T23:59:59Z", limit: 50 },
      buildContext(tmpHome),
    );
    expect(result.matched).toBe(2);
    expect(result.entries.map((e) => e.gmail_id)).toEqual(["m1", "m0"]);
  });

  it("applies limit cap (matched still reflects pre-cap total)", async () => {
    fixture(tmpHome);
    const result = await searchAuditTool.handler(
      { account: "alice", limit: 2 },
      buildContext(tmpHome),
    );
    expect(result.matched).toBe(3);
    expect(result.entries).toHaveLength(2);
    // Newest-first within alice: m3, m1, m0 → first 2 are m3, m1.
    expect(result.entries.map((e) => e.gmail_id)).toEqual(["m3", "m1"]);
  });

  it("throws ValidationError when until is not parseable ISO", async () => {
    fixture(tmpHome);
    await expect(
      searchAuditTool.handler(
        { until: "garbage", limit: 50 },
        buildContext(tmpHome),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
