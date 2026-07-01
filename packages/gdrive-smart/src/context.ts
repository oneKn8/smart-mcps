import { loadCreds } from "smart-mcp-core";
import { GDriveClient } from "./client.js";

/**
 * Per-request context exposed to every gdrive-smart tool handler. Carries the
 * live REST client. Tools that need the resolved account read it via
 * `client.getAccount()` rather than duplicating it on the context.
 */
export interface GDriveContext {
  client: GDriveClient;
}

const DEFAULT_IDENTITY = "your-account";

type GDriveCreds = {
  GDRIVE_DEFAULT_IDENTITY?: string;
};

/**
 * Construct the runtime context. Resolves `GDRIVE_DEFAULT_IDENTITY` from
 * env / shared `.env` / per-service config; defaults to `"your-account"`
 * when unset. The GDriveClient constructor is side-effect-free — no token
 * file is opened here.
 */
export function buildContext(home?: string): GDriveContext {
  const creds = loadCreds<Record<string, string>>({
    serviceName: "gdrive-smart",
    required: [],
    optional: ["GDRIVE_DEFAULT_IDENTITY"],
  }) as GDriveCreds;
  const account = creds.GDRIVE_DEFAULT_IDENTITY ?? DEFAULT_IDENTITY;
  return {
    client: new GDriveClient(
      account,
      home === undefined ? {} : { home },
    ),
  };
}
