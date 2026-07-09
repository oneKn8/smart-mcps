import { lstatSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { DriveIndex, DriveRoot, IndexedFile } from "./types.js";

export type ScanOptions = {
  roots: DriveRoot[];
  maxDepth?: number;
  limitFiles?: number;
  ignoreNames?: string[];
};

const defaultIgnore = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".Trash",
  "Trash",
]);

function fileId(rootId: string, rel: string): string {
  return `${rootId}:${rel}`;
}

export function scanRoots(opts: ScanOptions): DriveIndex {
  const files: IndexedFile[] = [];
  const skipped: DriveIndex["skipped"] = [];
  const ignore = new Set([...defaultIgnore, ...(opts.ignoreNames ?? [])]);
  const maxDepth = opts.maxDepth ?? 12;
  const limitFiles = opts.limitFiles ?? 100_000;

  function pushFile(
    root: DriveRoot,
    path: string,
    entry: string,
    size: number,
    modifiedMs: number,
  ): void {
    const rel = relative(root.path, path) || entry;
    files.push({
      id: fileId(root.id, rel),
      root_id: root.id,
      root_label: root.label,
      ...(root.account ? { account: root.account } : {}),
      path,
      relative_path: rel,
      name: entry,
      extension: extname(entry).toLowerCase(),
      size,
      modified_ms: modifiedMs,
      kind: "file",
    });
  }

  function walk(root: DriveRoot, dir: string, depth: number): void {
    if (files.length >= limitFiles) return;
    if (depth > maxDepth) {
      skipped.push({ path: dir, reason: "max_depth" });
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      skipped.push({ path: dir, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    for (const entry of entries) {
      if (files.length >= limitFiles) return;
      if (ignore.has(entry)) continue;
      const path = join(dir, entry);
      // `lstatSync` does NOT follow symlinks, so we can detect a link before we
      // decide to descend. Following directory symlinks with `statSync` lets a
      // cycle re-walk the tree down to maxDepth; detecting the link lets us skip
      // it instead.
      let lst;
      try {
        lst = lstatSync(path);
      } catch (err) {
        skipped.push({ path, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (lst.isSymbolicLink()) {
        // Resolve the target only to classify it. A symlinked file is indexed
        // (no cycle risk); a symlinked directory is skipped so we never follow
        // it. A broken link is recorded as skipped.
        let target;
        try {
          target = statSync(path);
        } catch {
          skipped.push({ path, reason: "broken_symlink" });
          continue;
        }
        if (target.isFile()) {
          pushFile(root, path, entry, target.size, target.mtimeMs);
        } else {
          skipped.push({ path, reason: "symlinked_dir" });
        }
        continue;
      }
      if (lst.isDirectory()) {
        walk(root, path, depth + 1);
        continue;
      }
      if (!lst.isFile()) continue;
      pushFile(root, path, entry, lst.size, lst.mtimeMs);
    }
  }

  for (const root of opts.roots.filter(r => r.exists)) {
    walk(root, root.path, 0);
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    roots: opts.roots,
    files,
    skipped,
  };
}
