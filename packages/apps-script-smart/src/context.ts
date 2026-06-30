import { loadCreds } from "smart-mcp-core";
import { AppsScriptClient } from "./client.js";

/**
 * Per-request context exposed to every apps-script-smart tool handler.
 * Carries the live REST client. Tools that need the resolved account read
 * it via `client.getAccount()` rather than duplicating it on the context.
 */
export interface AppsScriptContext {
  client: AppsScriptClient;
}

const DEFAULT_IDENTITY = "your-account";

type AppsScriptCreds = {
  APPS_SCRIPT_DEFAULT_IDENTITY?: string;
};

/**
 * Construct the runtime context. Resolves `APPS_SCRIPT_DEFAULT_IDENTITY`
 * from env / shared `.env` / per-service config; defaults to
 * `"your-account"` when unset. The AppsScriptClient constructor is
 * side-effect-free — no token file is opened here.
 */
export function buildContext(home?: string): AppsScriptContext {
  const creds = loadCreds<Record<string, string>>({
    serviceName: "apps-script-smart",
    required: [],
    optional: ["APPS_SCRIPT_DEFAULT_IDENTITY"],
  }) as AppsScriptCreds;
  const account = creds.APPS_SCRIPT_DEFAULT_IDENTITY ?? DEFAULT_IDENTITY;
  return {
    client: new AppsScriptClient(
      account,
      home === undefined ? {} : { home },
    ),
  };
}
