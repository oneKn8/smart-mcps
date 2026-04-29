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
import { NotFoundError } from "smart-mcp-core";
import { listIdentitiesTool, getIdentityTool } from "../tools/identities.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-id-tool-test-"));
}

function writeIdentity(home: string, fileBase: string, body: string): void {
  const dir = path.join(home, ".santo-agent", "identities");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${fileBase}.yaml`), body);
}

function buildContext(home: string): EmailContext {
  // Tools in this file never call the client, but EmailContext requires one.
  const client = {} as unknown as EmailClient;
  return { client, home };
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
  vi.restoreAllMocks();
});

describe("list_identities tool", () => {
  it("returns three identities sorted by account ascending", async () => {
    writeIdentity(
      tmpHome,
      "charlie",
      [
        "account: charlie",
        "email: charlie@example.com",
        "display_name: Charlie",
      ].join("\n"),
    );
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice",
      ].join("\n"),
    );
    writeIdentity(
      tmpHome,
      "bob",
      [
        "account: bob",
        "email: bob@example.com",
        "display_name: Bob",
        "transport: smtp",
      ].join("\n"),
    );
    const result = await listIdentitiesTool.handler({}, buildContext(tmpHome));
    expect(result.count).toBe(3);
    expect(result.identities.map((i) => i.account)).toEqual([
      "alice",
      "bob",
      "charlie",
    ]);
  });

  it("returns empty list when identities directory missing", async () => {
    const result = await listIdentitiesTool.handler({}, buildContext(tmpHome));
    expect(result).toEqual({ identities: [], count: 0 });
  });

  it("output items expose only account/email/display_name/transport keys", async () => {
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice",
        "default_footer: Footer here",
        "default_reply_to: reply@example.com",
        "signature_html: <strong>Alice</strong>",
        "signature_text: Alice",
      ].join("\n"),
    );
    const result = await listIdentitiesTool.handler({}, buildContext(tmpHome));
    expect(result.identities).toHaveLength(1);
    const item = result.identities[0]!;
    expect(Object.keys(item).sort()).toEqual([
      "account",
      "display_name",
      "email",
      "transport",
    ]);
  });

  it("transport defaults to oauth when missing on disk", async () => {
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice",
      ].join("\n"),
    );
    writeIdentity(
      tmpHome,
      "bob",
      [
        "account: bob",
        "email: bob@example.com",
        "display_name: Bob",
        "transport: smtp",
      ].join("\n"),
    );
    const result = await listIdentitiesTool.handler({}, buildContext(tmpHome));
    expect(result.identities.map((i) => i.transport)).toEqual([
      "oauth",
      "smtp",
    ]);
  });
});

describe("get_identity tool", () => {
  it("returns full shape minus signatures by default", async () => {
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice",
        "default_footer: Footer",
        "default_reply_to: reply@example.com",
        "signature_html: <strong>A</strong>",
        "signature_text: A",
      ].join("\n"),
    );
    const result = await getIdentityTool.handler(
      { account: "alice", include_signature: false },
      buildContext(tmpHome),
    );
    expect(Object.keys(result).sort()).toEqual([
      "account",
      "default_footer",
      "default_reply_to",
      "display_name",
      "email",
      "transport",
    ]);
    expect(result.account).toBe("alice");
    expect(result.email).toBe("alice@example.com");
    expect(result.display_name).toBe("Alice");
    expect(result.default_footer).toBe("Footer");
    expect(result.default_reply_to).toBe("reply@example.com");
    expect(result.transport).toBe("oauth");
  });

  it("throws NotFoundError when account missing", async () => {
    await expect(
      getIdentityTool.handler(
        { account: "ghost", include_signature: false },
        buildContext(tmpHome),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("includes signature_html + signature_text when include_signature: true", async () => {
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice",
        "signature_html: <strong>A</strong>",
        "signature_text: A",
      ].join("\n"),
    );
    const result = await getIdentityTool.handler(
      { account: "alice", include_signature: true },
      buildContext(tmpHome),
    );
    expect(result.signature_html).toBe("<strong>A</strong>");
    expect(result.signature_text).toBe("A");
  });

  it("default (include_signature unspecified) excludes signature fields", async () => {
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice",
        "signature_html: <strong>A</strong>",
        "signature_text: A",
      ].join("\n"),
    );
    // Caller omits include_signature entirely; zod default fills it as false.
    const result = await getIdentityTool.handler(
      { account: "alice" } as { account: string; include_signature: boolean },
      buildContext(tmpHome),
    );
    expect(Object.keys(result).sort()).toEqual([
      "account",
      "display_name",
      "email",
      "transport",
    ]);
    expect((result as Record<string, unknown>).signature_html).toBeUndefined();
    expect((result as Record<string, unknown>).signature_text).toBeUndefined();
  });
});
