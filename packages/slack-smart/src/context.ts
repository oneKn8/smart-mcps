import { SlackClient } from "./client.js";

export interface SlackContext {
  client: SlackClient;
}

// SlackClient's constructor calls loadCreds() synchronously and throws an
// AuthError when required env vars / config files are missing. Constructing
// here surfaces credential errors at server startup rather than on the first
// tool call.
export function buildContext(): SlackContext {
  return { client: new SlackClient() };
}
