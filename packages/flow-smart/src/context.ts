import { loadCreds } from "smart-mcp-core";
import { TasksClient } from "tasks-smart/client";
import { DocsClient } from "docs-smart/client";
import { AppsScriptClient } from "apps-script-smart/client";
import { CalendarClient } from "calendar-smart/client";
import { EmailClient } from "email-smart/client";

/**
 * Per-request context exposed to every flow-smart tool handler. flow-smart
 * owns no API code of its own; each tool is glue over the sibling clients
 * imported via their `./client` subpath exports. All five clients are
 * constructed against the same bound account.
 *
 * The four Google clients share the `(account, opts)` constructor shape;
 * EmailClient is the odd one out (multi-account, `(home?)` constructor) and
 * resolves the account per-call from its own token jar.
 */
export interface FlowContext {
  tasks: TasksClient;
  docs: DocsClient;
  appsScript: AppsScriptClient;
  calendar: CalendarClient;
  email: EmailClient;
  /**
   * The resolved bound account. The four Google clients are constructed
   * against it; `EmailClient` is multi-account and resolves the account
   * per-call, so the email flow tools pass this value explicitly.
   */
  account: string;
}

const DEFAULT_IDENTITY = "your-account";

type FlowCreds = {
  FLOW_DEFAULT_IDENTITY?: string;
};

/**
 * Construct the runtime context. Resolves `FLOW_DEFAULT_IDENTITY` from
 * env / shared `.env` / per-service config; defaults to `"your-account"`
 * when unset. Every client constructor is side-effect-free — no token file
 * is opened here; flow-smart reuses whatever sibling tokens already exist
 * (`<account>.tasks.json`, `.docs.json`, `.script.json`, `.calendar.json`,
 * and email-smart's `<account>.json`).
 */
export function buildContext(home?: string): FlowContext {
  const creds = loadCreds<Record<string, string>>({
    serviceName: "flow-smart",
    required: [],
    optional: ["FLOW_DEFAULT_IDENTITY"],
  }) as FlowCreds;
  const account = creds.FLOW_DEFAULT_IDENTITY ?? DEFAULT_IDENTITY;
  const googleOpts = home === undefined ? {} : { home };
  return {
    tasks: new TasksClient(account, googleOpts),
    docs: new DocsClient(account, googleOpts),
    appsScript: new AppsScriptClient(account, googleOpts),
    calendar: new CalendarClient(account, googleOpts),
    email: home === undefined ? new EmailClient() : new EmailClient(home),
    account,
  };
}
