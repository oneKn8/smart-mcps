import { loadCreds } from "smart-mcp-core";
import { CalendarClient } from "./client.js";

/**
 * Per-request context exposed to every calendar-smart tool handler. Carries
 * the live REST client. Tools that need the resolved account read it via
 * `client.getAccount()` rather than duplicating it on the context.
 */
export interface CalendarContext {
  client: CalendarClient;
}

type CalendarCreds = {
  CALENDAR_DEFAULT_IDENTITY: string;
};

/**
 * Construct the runtime context. Resolves `CALENDAR_DEFAULT_IDENTITY` from
 * env / shared `.env` / per-service config; throws `AuthError` at
 * startup when unset. The CalendarClient constructor is side-effect-free — no token
 * file is opened here.
 */
export function buildContext(home?: string): CalendarContext {
  const creds = loadCreds<Record<string, string>>({
    serviceName: "calendar-smart",
    required: ["CALENDAR_DEFAULT_IDENTITY"],
  }) as CalendarCreds;
  const account = creds.CALENDAR_DEFAULT_IDENTITY;
  return {
    client: new CalendarClient(
      account,
      home === undefined ? {} : { home },
    ),
  };
}
