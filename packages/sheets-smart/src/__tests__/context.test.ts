import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext } from "../context.js";
import { SheetsClient } from "../client.js";

// loadCreds reads process.env first, then `~/.config/smart-mcps/.env`, then
// per-service config. Override HOME to an empty tmpdir so no real shared .env
// leaks the identity, and scrub the env var between tests.
let savedHome: string | undefined;
let savedIdentity: string | undefined;
let tmpHome: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedIdentity = process.env.SHEETS_DEFAULT_IDENTITY;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sheets-context-"));
  process.env.HOME = tmpHome;
  delete process.env.SHEETS_DEFAULT_IDENTITY;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedIdentity === undefined) delete process.env.SHEETS_DEFAULT_IDENTITY;
  else process.env.SHEETS_DEFAULT_IDENTITY = savedIdentity;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("buildContext", () => {
  it("returns a context with a SheetsClient", () => {
    const ctx = buildContext(tmpHome);
    expect(ctx.client).toBeInstanceOf(SheetsClient);
  });

  it("defaults the account to your-account when no override is set", () => {
    const ctx = buildContext(tmpHome);
    expect(ctx.client.getAccount()).toBe("your-account");
  });

  it("honors a SHEETS_DEFAULT_IDENTITY env override", () => {
    process.env.SHEETS_DEFAULT_IDENTITY = "alt-account";
    const ctx = buildContext(tmpHome);
    expect(ctx.client.getAccount()).toBe("alt-account");
  });
});
