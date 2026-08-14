import { loadCreds } from "smart-mcp-core";
import { TasksClient } from "tasks-smart/client";
import { DocsClient } from "docs-smart/client";
import { AppsScriptClient } from "apps-script-smart/client";
import { CalendarClient } from "calendar-smart/client";
import { EmailClient } from "email-smart/client";

/**
 * Per-request context exposed to every flow-smart tool handler. flow-smart
 * owns no API code of its own; each tool is glue over the sibling clients
 * imported via their `./client` subpath exports.
 *
 * Tasks, Docs, and Calendar share the `(account, opts)` constructor shape and
 * bind the account at construction. AppsScriptClient and EmailClient are
 * multi-account (`(home?)` constructor) and resolve the account per-call, so
 * flow-smart passes its bound `account` explicitly on every apps-script/email call.
 */
export interface FlowContext {
  tasks: TasksClient;
  docs: DocsClient;
  appsScript: AppsScriptClient;
  calendar: CalendarClient;
  email: EmailClient;
  /**
   * The resolved bound account. Tasks/Docs/Calendar are constructed against
   * it; `AppsScriptClient` and `EmailClient` are multi-account and receive it
   * per-call, so the apps-script and email flow tools pass this value explicitly.
   */
  account: string;
}

type FlowCreds = {
  FLOW_DEFAULT_IDENTITY: string;
};

/**
 * Construct the runtime context. Resolves `FLOW_DEFAULT_IDENTITY` from
 * env / shared `.env` / per-service config; throws `AuthError` at startup
 * when unset (eager-fail, matching the client constructor convention).
 * Every client constructor is side-effect-free — no token file
 * is opened here; flow-smart reuses whatever sibling tokens already exist
 * (`<account>.tasks.json`, `.docs.json`, `.script.json`, `.calendar.json`,
 * and email-smart's `<account>.json`).
 */
export function buildContext(home?: string): FlowContext {
  const creds = loadCreds<Record<string, string>>({
    serviceName: "flow-smart",
    required: ["FLOW_DEFAULT_IDENTITY"],
  }) as FlowCreds;
  const account = creds.FLOW_DEFAULT_IDENTITY;
  const googleOpts = home === undefined ? {} : { home };
  return {
    tasks: new TasksClient(account, googleOpts),
    docs: new DocsClient(account, googleOpts),
    appsScript: new AppsScriptClient(home),
    calendar: new CalendarClient(account, googleOpts),
    email: home === undefined ? new EmailClient() : new EmailClient(home),
    account,
  };
}
