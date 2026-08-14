import type { AppsScriptContext } from "../context.js";

/**
 * Resolve the account an apps-script tool call should act on. Every tool takes
 * an optional `account`; this centralizes the fallback so behavior is uniform
 * and backward compatible. Resolution order:
 *   1. the explicit `account` argument, if a non-empty string;
 *   2. the `APPS_SCRIPT_DEFAULT_IDENTITY` env var, if set (read at call time so
 *      it can be overridden per-process without rebuilding the context);
 *   3. `context.defaultAccount` (resolved once at startup via loadCreds, which
 *      itself requires `APPS_SCRIPT_DEFAULT_IDENTITY`).
 *
 * Unlike email-smart there is no identities directory to validate against —
 * apps-script accounts are just `<account>.script.json` token slots under
 * `~/.santo-agent/oauth/` — so a bad account surfaces as a token-not-found
 * AuthError from the client on first use rather than here.
 */
export function resolveAccount(
  account: string | undefined,
  context: AppsScriptContext,
): string {
  if (typeof account === "string" && account.length > 0) return account;

  const envDefault = process.env.APPS_SCRIPT_DEFAULT_IDENTITY;
  if (typeof envDefault === "string" && envDefault.length > 0) {
    return envDefault;
  }

  return context.defaultAccount;
}
