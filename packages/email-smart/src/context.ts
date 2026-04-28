import { EmailClient } from "./client.js";

export interface EmailContext {
  client: EmailClient;
  /**
   * Optional override for the user home directory. Tools that read identity
   * yaml or write the audit log resolve paths against this. Falls back to
   * `process.env.HOME` at use time when undefined.
   */
  home?: string;
}

/**
 * Construct the runtime context. Calling `new EmailClient()` here does NOT
 * perform any network or credential reads — it just stores `home`. OAuth
 * credentials are loaded lazily on the first `sendMessage` call.
 */
export function buildContext(home?: string): EmailContext {
  if (home === undefined) {
    return { client: new EmailClient() };
  }
  return { client: new EmailClient(home), home };
}
