import { loadCreds } from "smart-mcp-core";
import { SheetsClient } from "./client.js";

/**
 * Per-request context exposed to every sheets-smart tool handler. Carries the
 * live REST client. Tools that need the resolved account read it via
 * `client.getAccount()` rather than duplicating it on the context.
 */
export interface SheetsContext {
  client: SheetsClient;
}

type SheetsCreds = {
  SHEETS_DEFAULT_IDENTITY: string;
};

/**
 * Construct the runtime context. Resolves `SHEETS_DEFAULT_IDENTITY` from env /
 * shared `.env` / per-service config; throws `AuthError` at startup when unset.
 * The SheetsClient constructor is side-effect-free — no token file is opened
 * here.
 */
export function buildContext(home?: string): SheetsContext {
  const creds = loadCreds<Record<string, string>>({
    serviceName: "sheets-smart",
    required: ["SHEETS_DEFAULT_IDENTITY"],
  }) as SheetsCreds;
  const account = creds.SHEETS_DEFAULT_IDENTITY;
  return {
    client: new SheetsClient(
      account,
      home === undefined ? {} : { home },
    ),
  };
}
