import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ValidationError } from "smart-mcp-core";
import { indexPath } from "./paths.js";
import type { DriveIndex } from "./types.js";

export function emptyIndex(): DriveIndex {
  return {
    version: 1,
    generated_at: new Date(0).toISOString(),
    roots: [],
    files: [],
    skipped: [],
  };
}

export function loadIndex(home?: string): DriveIndex {
  const path = indexPath(home);
  if (!existsSync(path)) return emptyIndex();
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as DriveIndex;
  } catch (err) {
    throw new ValidationError(`drive-smart index is not valid JSON: ${path}`, {
      cause: err,
    });
  }
}

export function saveIndex(index: DriveIndex, home?: string): string {
  const path = indexPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index, null, 2));
  return path;
}
