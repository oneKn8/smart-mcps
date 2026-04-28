import { RunpodClient } from "./client.js";

export interface RunpodContext {
  client: RunpodClient;
}

// RunpodClient's constructor calls loadCreds() synchronously and throws an
// AuthError when required env vars / config files are missing. Constructing
// here surfaces credential errors at server startup rather than on the first
// tool call.
export function buildContext(): RunpodContext {
  return { client: new RunpodClient() };
}
