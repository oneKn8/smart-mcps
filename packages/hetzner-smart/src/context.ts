import { HetznerClient } from "./client.js";

/**
 * Per-request context handed to every tool handler.
 *
 * Constructing the client here (eager) surfaces a missing `HETZNER_API_TOKEN`
 * as an `AuthError` at server startup rather than on the first tool call.
 */
export interface HetznerContext {
  client: HetznerClient;
}

export function buildContext(): HetznerContext {
  return { client: new HetznerClient() };
}
