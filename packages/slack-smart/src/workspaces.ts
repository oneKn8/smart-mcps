import { homedir } from "node:os";
import { AuthError, ValidationError, readDotenvFile } from "smart-mcp-core";
import { SlackClient, type SlackCreds } from "./client.js";

/**
 * One Slack workspace the server can talk to. Tokens come from the shared
 * env as `SLACK_USER_TOKEN_<NAME>` (and optionally `SLACK_BOT_TOKEN_<NAME>`);
 * `name` is the lower-cased suffix and is what tools accept as `workspace`.
 */
export type WorkspaceEntry = {
  name: string;
  userToken: string;
  botToken?: string;
};

export type DiscoveredWorkspaces = {
  workspaces: Map<string, WorkspaceEntry>;
  defaultName: string;
};

const USER_PREFIX = "SLACK_USER_TOKEN_";
const BOT_PREFIX = "SLACK_BOT_TOKEN_";
const LEGACY_USER = "SLACK_USER_TOKEN";
const LEGACY_BOT = "SLACK_BOT_TOKEN";
const DEFAULT_KEY = "SLACK_DEFAULT_WORKSPACE";
const LEGACY_NAME = "default";
const SHARED_ENV_PATH = "~/.config/smart-mcps/.env";

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * Shape the environment into workspaces. Named tokens win; the bare legacy
 * pair is only used when no named workspace exists, and then appears as the
 * workspace called "default" so existing single-workspace setups keep working.
 */
export function discoverWorkspaces(
  env: Record<string, string | undefined>,
): DiscoveredWorkspaces {
  const workspaces = new Map<string, WorkspaceEntry>();
  const orphanBots: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(USER_PREFIX) || !present(value)) continue;
    const name = key.slice(USER_PREFIX.length).toLowerCase();
    const botToken = env[BOT_PREFIX + key.slice(USER_PREFIX.length)];
    workspaces.set(name, {
      name,
      userToken: value,
      ...(present(botToken) ? { botToken } : {}),
    });
  }

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(BOT_PREFIX) || !present(value)) continue;
    const suffix = key.slice(BOT_PREFIX.length);
    if (!workspaces.has(suffix.toLowerCase())) orphanBots.push(key);
  }
  if (orphanBots.length > 0) {
    throw new AuthError(
      `Bot token(s) without a matching user token: ${orphanBots.join(", ")}. ` +
        `Each SLACK_BOT_TOKEN_<NAME> needs a SLACK_USER_TOKEN_<NAME>.`,
    );
  }

  if (workspaces.size === 0 && present(env[LEGACY_USER])) {
    const botToken = env[LEGACY_BOT];
    workspaces.set(LEGACY_NAME, {
      name: LEGACY_NAME,
      userToken: env[LEGACY_USER],
      ...(present(botToken) ? { botToken } : {}),
    });
  }

  if (workspaces.size === 0) {
    throw new AuthError(
      "No Slack workspace is configured. Set SLACK_USER_TOKEN_<NAME> for each " +
        `workspace (for example SLACK_USER_TOKEN_TBC) in ${SHARED_ENV_PATH}, ` +
        "or the single legacy SLACK_USER_TOKEN.",
    );
  }

  const names = [...workspaces.keys()];
  const requested = env[DEFAULT_KEY];
  let defaultName: string;
  if (present(requested)) {
    defaultName = requested.toLowerCase();
    if (!workspaces.has(defaultName)) {
      throw new AuthError(
        `${DEFAULT_KEY}="${requested}" is not a configured workspace; ` +
          `configured: ${names.join(", ")}.`,
      );
    }
  } else if (names.length === 1 && names[0] !== undefined) {
    defaultName = names[0];
  } else {
    throw new AuthError(
      `Several Slack workspaces are configured (${names.join(", ")}); ` +
        `set ${DEFAULT_KEY} to the one tools should use when no workspace is given.`,
    );
  }

  return { workspaces, defaultName };
}

/** Merge process.env over the shared dotenv file for the Slack keys only. */
export function loadWorkspaceEnv(
  sharedEnvPath: string = SHARED_ENV_PATH,
): Record<string, string | undefined> {
  const path = sharedEnvPath.startsWith("~/")
    ? sharedEnvPath.replace(/^~/, homedir())
    : sharedEnvPath;
  const merged: Record<string, string | undefined> = {};
  for (const source of [readDotenvFile(path), process.env]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith("SLACK_")) merged[key] = value;
    }
  }
  return merged;
}

/** Builds one SlackClient per workspace on first use and hands it out by name. */
export class WorkspaceRegistry {
  readonly defaultName: string;
  private readonly entries: Map<string, WorkspaceEntry>;
  private readonly clients = new Map<string, SlackClient>();
  private readonly makeClient: (entry: WorkspaceEntry) => SlackClient;

  constructor(
    discovered: DiscoveredWorkspaces,
    makeClient: (entry: WorkspaceEntry) => SlackClient = entry =>
      new SlackClient(toCreds(entry)),
  ) {
    this.entries = discovered.workspaces;
    this.defaultName = discovered.defaultName;
    this.makeClient = makeClient;
  }

  /** Configured workspace names, default first. */
  names(): string[] {
    const rest = [...this.entries.keys()].filter(n => n !== this.defaultName).sort();
    return [this.defaultName, ...rest];
  }

  entry(name: string): WorkspaceEntry {
    const entry = this.entries.get(name.toLowerCase());
    if (!entry) {
      throw new ValidationError(
        `Unknown Slack workspace "${name}"; configured: ${this.names().join(", ")}.`,
      );
    }
    return entry;
  }

  clientFor(workspace: string | undefined): SlackClient {
    const entry = this.entry(workspace ?? this.defaultName);
    let client = this.clients.get(entry.name);
    if (!client) {
      client = this.makeClient(entry);
      this.clients.set(entry.name, client);
    }
    return client;
  }
}

function toCreds(entry: WorkspaceEntry): SlackCreds {
  return {
    SLACK_USER_TOKEN: entry.userToken,
    ...(entry.botToken !== undefined ? { SLACK_BOT_TOKEN: entry.botToken } : {}),
  };
}
