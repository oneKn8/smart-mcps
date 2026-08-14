import { loadCreds } from "smart-mcp-core";
import { TasksClient } from "./client.js";

/**
 * Per-request context exposed to every tasks-smart tool handler. Carries the
 * live REST client. Tools that need the resolved account read it via
 * `client.getAccount()` rather than duplicating it on the context.
 */
export interface TasksContext {
  client: TasksClient;
}

type TasksCreds = {
  TASKS_DEFAULT_IDENTITY: string;
};

/**
 * Construct the runtime context. Resolves `TASKS_DEFAULT_IDENTITY` from
 * env / shared `.env` / per-service config; throws `AuthError` at
 * startup when unset. The TasksClient constructor is side-effect-free — no token
 * file is opened here.
 */
export function buildContext(home?: string): TasksContext {
  const creds = loadCreds<Record<string, string>>({
    serviceName: "tasks-smart",
    required: ["TASKS_DEFAULT_IDENTITY"],
  }) as TasksCreds;
  const account = creds.TASKS_DEFAULT_IDENTITY;
  return {
    client: new TasksClient(
      account,
      home === undefined ? {} : { home },
    ),
  };
}
