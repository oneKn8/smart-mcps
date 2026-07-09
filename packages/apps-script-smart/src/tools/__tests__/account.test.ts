import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveAccount } from "../account.js";
import type { AppsScriptContext } from "../../context.js";

let savedEnv: string | undefined;

// A context whose defaultAccount is the last-resort fallback. The client field
// is never touched by resolveAccount, so a stub is fine.
function ctx(defaultAccount = "ctx-default"): AppsScriptContext {
  return {
    client: {} as unknown as AppsScriptContext["client"],
    defaultAccount,
  };
}

beforeEach(() => {
  savedEnv = process.env.APPS_SCRIPT_DEFAULT_IDENTITY;
  delete process.env.APPS_SCRIPT_DEFAULT_IDENTITY;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.APPS_SCRIPT_DEFAULT_IDENTITY;
  else process.env.APPS_SCRIPT_DEFAULT_IDENTITY = savedEnv;
});

describe("resolveAccount", () => {
  it("returns the explicit account when provided (wins over env + ctx)", () => {
    process.env.APPS_SCRIPT_DEFAULT_IDENTITY = "env-acct";
    expect(resolveAccount("bob", ctx("ctx-default"))).toBe("bob");
  });

  it("ignores an empty-string account and falls through", () => {
    expect(resolveAccount("", ctx("ctx-default"))).toBe("ctx-default");
  });

  it("falls back to APPS_SCRIPT_DEFAULT_IDENTITY when account omitted", () => {
    process.env.APPS_SCRIPT_DEFAULT_IDENTITY = "env-acct";
    expect(resolveAccount(undefined, ctx("ctx-default"))).toBe("env-acct");
  });

  it("falls back to ctx.defaultAccount when neither account nor env is set", () => {
    expect(resolveAccount(undefined, ctx("ctx-default"))).toBe("ctx-default");
  });
});
