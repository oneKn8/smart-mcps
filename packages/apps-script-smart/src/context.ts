import { loadCreds } from "smart-mcp-core";
import { AppsScriptClient } from "./client.js";

/**
 * Per-request context exposed to every apps-script-smart tool handler.
 * Carries the live multi-account REST client plus the default account a tool
 * call falls back to when its optional `account` param is omitted (and no
 * `APPS_SCRIPT_DEFAULT_IDENTITY` env override is set). Account resolution for
 * a given call lives in `tools/account.ts`.
 */
export interface AppsScriptContext {
  client: AppsScriptClient;
  defaultAccount: string;
}

const DEFAULT_IDENTITY = "your-account";

type AppsScriptCreds = {
  APPS_SCRIPT_DEFAULT_IDENTITY?: string;
};

/**
 * Construct the runtime context. Resolves the default account from
 * `APPS_SCRIPT_DEFAULT_IDENTITY` (env / shared `.env` / per-service config),
 * defaulting to `"your-account"` when unset. The AppsScriptClient is now
 * account-agnostic — each tool call passes its resolved account — so the
 * constructor takes only the optional `home` override and opens no token file.
 */
export function buildContext(home?: string): AppsScriptContext {
  const creds = loadCreds<Record<string, string>>({
    serviceName: "apps-script-smart",
    required: [],
    optional: ["APPS_SCRIPT_DEFAULT_IDENTITY"],
  }) as AppsScriptCreds;
  const defaultAccount = creds.APPS_SCRIPT_DEFAULT_IDENTITY ?? DEFAULT_IDENTITY;
  return {
    client: new AppsScriptClient(home),
    defaultAccount,
  };
}
