import { SlackClient } from "./client.js";
import {
  discoverWorkspaces,
  loadWorkspaceEnv,
  WorkspaceRegistry,
} from "./workspaces.js";

export interface SlackContext {
  /** Client for the workspace the current call is acting in. */
  client: SlackClient;
  /** Every configured workspace; the server swaps `client` per call from here. */
  workspaces: WorkspaceRegistry;
}

// discoverWorkspaces() throws an AuthError when no token is configured or the
// default is ambiguous. Building here surfaces credential errors at server
// startup rather than on the first tool call.
export function buildContext(): SlackContext {
  const workspaces = new WorkspaceRegistry(discoverWorkspaces(loadWorkspaceEnv()));
  return { client: workspaces.clientFor(undefined), workspaces };
}
