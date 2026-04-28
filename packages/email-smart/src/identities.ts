import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { NotFoundError, ValidationError } from "smart-mcp-core";

export type Identity = {
  account: string;
  email: string;
  display_name: string;
  default_footer?: string;
  default_reply_to?: string;
  signature_html?: string;
  signature_text?: string;
  transport: "oauth" | "smtp";
};

const DEFAULT_TRANSPORT: Identity["transport"] = "oauth";
const REQUIRED_STRING_FIELDS = ["account", "email", "display_name"] as const;
const OPTIONAL_STRING_FIELDS = [
  "default_footer",
  "default_reply_to",
  "signature_html",
  "signature_text",
] as const;

function identityDir(home: string): string {
  return path.join(home, ".santo-agent", "identities");
}

function identityFile(home: string, account: string): string {
  return path.join(identityDir(home), `${account}.yaml`);
}

function resolveHome(home: string | undefined): string {
  if (home !== undefined) return home;
  const env = process.env.HOME;
  if (!env) {
    throw new ValidationError(
      "HOME environment variable is not set; cannot locate ~/.santo-agent/identities",
    );
  }
  return env;
}

function asStringOrUndefined(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ValidationError(`identity field "${field}" must be a string`);
  }
  return value;
}

/**
 * Validate a parsed yaml document and shape it into an Identity. The
 * `requestedAccount` argument enforces that the file's `account` field matches
 * the file name (catches stale renames / typos). Pass undefined to skip that
 * check (used by `listIdentities`).
 */
function validateIdentity(
  parsed: unknown,
  requestedAccount: string | undefined,
): Identity {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("identity yaml must be a mapping");
  }
  const obj = parsed as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    const v = obj[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new ValidationError(`identity missing required field "${field}"`);
    }
  }

  const account = obj["account"] as string;
  const email = obj["email"] as string;
  const display_name = obj["display_name"] as string;

  if (requestedAccount !== undefined && account !== requestedAccount) {
    throw new ValidationError(
      `identity file account "${account}" does not match requested account "${requestedAccount}"`,
    );
  }

  let transport: Identity["transport"];
  const rawTransport = obj["transport"];
  if (rawTransport === undefined || rawTransport === null) {
    transport = DEFAULT_TRANSPORT;
  } else if (rawTransport === "oauth" || rawTransport === "smtp") {
    transport = rawTransport;
  } else {
    throw new ValidationError(
      `identity field "transport" must be "oauth" or "smtp", got "${String(rawTransport)}"`,
    );
  }

  const identity: Identity = {
    account,
    email,
    display_name,
    transport,
  };

  for (const field of OPTIONAL_STRING_FIELDS) {
    const v = asStringOrUndefined(obj[field], field);
    if (v !== undefined) identity[field] = v;
  }

  return identity;
}

export function loadIdentity(account: string, home?: string): Identity {
  const root = resolveHome(home);
  const filePath = identityFile(root, account);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError(`identity not found: ${account}`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ValidationError(
      `identity file at ${filePath} is not valid YAML: ${(err as Error).message}`,
    );
  }
  return validateIdentity(parsed, account);
}

export function listIdentities(home?: string): Identity[] {
  const root = resolveHome(home);
  const dir = identityDir(root);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const results: Identity[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const filePath = path.join(dir, entry);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      console.error(
        `[email-smart] skipping unreadable identity ${filePath}: ${(err as Error).message}`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      console.error(
        `[email-smart] skipping malformed identity ${filePath}: ${(err as Error).message}`,
      );
      continue;
    }
    try {
      // Pass undefined for requestedAccount so listing tolerates the absence
      // of a file-name check (caller is enumerating, not addressing).
      results.push(validateIdentity(parsed, undefined));
    } catch (err) {
      console.error(
        `[email-smart] skipping malformed identity ${filePath}: ${(err as Error).message}`,
      );
    }
  }
  results.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return results;
}
