import { existsSync, readFileSync } from "node:fs";
import { ValidationError } from "smart-mcp-core";
import { configPath } from "./paths.js";
import type { DriveSmartConfig } from "./types.js";

export function loadConfig(home?: string): DriveSmartConfig {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as DriveSmartConfig;
  } catch (err) {
    throw new ValidationError(`drive-smart config is not valid JSON: ${path}`, {
      cause: err,
    });
  }
}
