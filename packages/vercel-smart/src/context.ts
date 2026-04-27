import { VercelClient } from "./client.js";

export interface VercelContext {
  client: VercelClient;
}

// VercelClient's constructor calls loadCreds() synchronously and throws an
// AuthError when required env vars / config files are missing. Constructing
// here surfaces credential errors at server startup rather than on the first
// tool call.
export function buildContext(): VercelContext {
  return { client: new VercelClient() };
}
