import { loadCreds } from "smart-mcp-core";
import { DocsClient } from "./client.js";

/**
 * Per-request context exposed to every docs-smart tool handler. Carries the
 * live REST client. Tools that need the resolved account read it via
 * `client.getAccount()` rather than duplicating it on the context.
 */
export interface DocsContext {
  client: DocsClient;
}

type DocsCreds = {
  DOCS_DEFAULT_IDENTITY: string;
};

/**
 * Construct the runtime context. Resolves `DOCS_DEFAULT_IDENTITY` from
 * env / shared `.env` / per-service config; throws `AuthError` at
 * startup when unset. The DocsClient constructor is side-effect-free — no token
 * file is opened here.
 */
export function buildContext(home?: string): DocsContext {
  const creds = loadCreds<Record<string, string>>({
    serviceName: "docs-smart",
    required: ["DOCS_DEFAULT_IDENTITY"],
  }) as DocsCreds;
  const account = creds.DOCS_DEFAULT_IDENTITY;
  return {
    client: new DocsClient(
      account,
      home === undefined ? {} : { home },
    ),
  };
}
