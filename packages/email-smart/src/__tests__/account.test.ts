import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ValidationError } from "smart-mcp-core";
import { resolveAccount, rejectIfSmtp } from "../tools/account.js";
import type { EmailContext } from "../context.js";

let tmpHome: string;
let savedHome: string | undefined;
let savedDefault: string | undefined;

function ctx(): EmailContext {
  return { client: {} as unknown as EmailContext["client"], home: tmpHome };
}

function writeIdentity(account: string, transport = "oauth"): void {
  const dir = path.join(tmpHome, ".santo-agent", "identities");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${account}.yaml`),
    [
      `account: ${account}`,
      `email: ${account}@example.com`,
      `display_name: ${account}`,
      `transport: ${transport}`,
    ].join("\n"),
  );
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "santo-account-test-"));
  savedHome = process.env.HOME;
  savedDefault = process.env.EMAIL_DEFAULT_ACCOUNT;
  process.env.HOME = tmpHome;
  delete process.env.EMAIL_DEFAULT_ACCOUNT;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDefault === undefined) delete process.env.EMAIL_DEFAULT_ACCOUNT;
  else process.env.EMAIL_DEFAULT_ACCOUNT = savedDefault;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("resolveAccount", () => {
  it("returns the explicit account when provided", () => {
    writeIdentity("alice");
    writeIdentity("bob");
    expect(resolveAccount("bob", ctx())).toBe("bob");
  });

  it("falls back to EMAIL_DEFAULT_ACCOUNT when account omitted", () => {
    writeIdentity("alice");
    writeIdentity("bob");
    process.env.EMAIL_DEFAULT_ACCOUNT = "alice";
    expect(resolveAccount(undefined, ctx())).toBe("alice");
  });

  it("falls back to the single configured identity", () => {
    writeIdentity("solo");
    expect(resolveAccount(undefined, ctx())).toBe("solo");
  });

  it("throws when multiple identities and no default", () => {
    writeIdentity("alice");
    writeIdentity("bob");
    expect(() => resolveAccount(undefined, ctx())).toThrow(ValidationError);
  });

  it("throws when no identities are configured", () => {
    expect(() => resolveAccount(undefined, ctx())).toThrow(ValidationError);
  });
});

describe("rejectIfSmtp", () => {
  it("passes for oauth identities", () => {
    writeIdentity("alice", "oauth");
    expect(() => rejectIfSmtp("alice", tmpHome)).not.toThrow();
  });

  it("throws for smtp identities", () => {
    writeIdentity("alice", "smtp");
    expect(() => rejectIfSmtp("alice", tmpHome)).toThrow(ValidationError);
  });
});
