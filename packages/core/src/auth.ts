import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { AuthError } from "./errors.js";

export type LoadCredsOpts<T extends Record<string, string>> = {
  serviceName: string;
  required: ReadonlyArray<keyof T>;
  optional?: ReadonlyArray<keyof T>;
  configPaths?: string[];
};

export function loadCreds<T extends Record<string, string>>(
  opts: LoadCredsOpts<T>,
): T {
  const { serviceName, required, optional = [] } = opts;
  const configPaths = (opts.configPaths ?? defaultConfigPaths(serviceName)).map(expandHome);
  const fromFile = readFirstConfig(configPaths);

  const result: Partial<Record<keyof T, string>> = {};
  const missing: string[] = [];

  for (const key of required) {
    const value = process.env[key as string] ?? fromFile[key as string];
    if (value === undefined || value === "") {
      missing.push(key as string);
    } else {
      result[key] = value;
    }
  }

  for (const key of optional) {
    const value = process.env[key as string] ?? fromFile[key as string];
    if (value !== undefined && value !== "") {
      result[key] = value;
    }
  }

  if (missing.length > 0) {
    throw new AuthError(
      `Missing required credentials for ${serviceName}: ${missing.join(", ")}`,
      {
        recovery: `Set as env vars or add to a config file at one of: ${configPaths.join(", ")}`,
        detail: { missing, serviceName, configPaths },
      },
    );
  }

  return result as T;
}

function defaultConfigPaths(serviceName: string): string[] {
  return [
    `~/.config/${serviceName}.json`,
    `~/.config/codex/${serviceName}.json`,
    `~/.${serviceName}.json`,
  ];
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return path.replace(/^~/, homedir());
  return path;
}

function readFirstConfig(paths: string[]): Record<string, string> {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, string>;
      }
    } catch {
      // Malformed file → skip silently; missing-required will throw later if needed.
    }
  }
  return {};
}
