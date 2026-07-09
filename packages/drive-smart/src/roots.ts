import { existsSync, readdirSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type { DriveRoot, DriveSmartConfig } from "./types.js";

export type DiscoverOptions = {
  /** gvfs mount base, e.g. `/run/user/1000/gvfs`. When omitted, gvfs auto-discovery is skipped. */
  gvfsBase?: string;
  /** home directory used to probe common local Drive folders. When omitted, that probe is skipped. */
  home?: string;
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function accountFromGvfsName(name: string): string | undefined {
  const user = /user=([^,/]+)/.exec(name)?.[1];
  const host = /host=([^,/]+)/.exec(name)?.[1];
  if (!user || !host) return undefined;
  return `${user}@${host}`;
}

/**
 * True when `path` lives inside the gvfs mount base (a network-backed FUSE
 * mount). Used to decide which roots are "network" so scans can skip them by
 * default and callers can see the network flag in `drive_roots`.
 */
export function isGvfsPath(path: string, gvfsBase?: string): boolean {
  if (!gvfsBase) return false;
  const base = gvfsBase.endsWith(sep) ? gvfsBase : gvfsBase + sep;
  return path === gvfsBase || path.startsWith(base);
}

export function discoverRoots(
  config: DriveSmartConfig = {},
  opts: DiscoverOptions = {},
): DriveRoot[] {
  const { gvfsBase, home } = opts;
  const roots: DriveRoot[] = [];
  const seen = new Set<string>();

  for (const item of config.roots ?? []) {
    const id = item.id ?? slug(item.path);
    roots.push({
      id,
      label: item.label ?? basename(item.path) ?? id,
      path: item.path,
      account: item.account,
      kind: item.kind ?? "unknown",
      source: "config",
      // Never `statSync` a gvfs path here: a stale FUSE backend makes that call
      // block forever. Assume a configured network mount exists; scanning it is
      // still opt-in.
      exists: isGvfsPath(item.path, gvfsBase) ? true : existsSync(item.path),
    });
    seen.add(item.path);
  }

  // Bounded, top-level probe of the gvfs mount base. We read ONLY the base
  // directory (served instantly by the local gvfsd-fuse daemon) to enumerate
  // mount names and parse the account from each name. We deliberately do NOT
  // `statSync` or `readdirSync` INSIDE a google-drive mount: a stale/slow FUSE
  // backend makes those calls block indefinitely. Each google-drive mount
  // becomes a single network root at the mount path; `drive_scan` skips it by
  // default.
  if (gvfsBase && existsSync(gvfsBase)) {
    let mounts: string[] = [];
    try {
      mounts = readdirSync(gvfsBase);
    } catch {
      mounts = [];
    }
    for (const mountName of mounts) {
      if (!mountName.startsWith("google-drive:")) continue;
      const mountPath = join(gvfsBase, mountName);
      if (seen.has(mountPath)) continue;
      const account = accountFromGvfsName(mountName);
      const label = account ?? mountName;
      roots.push({
        id: slug(label),
        label,
        path: mountPath,
        ...(account ? { account } : {}),
        kind: "google-drive",
        source: "auto",
        // Listed by the base readdir, so the mount exists; we do not stat it
        // (that would hang on a stale backend).
        exists: true,
      });
      seen.add(mountPath);
    }
  }

  if (home) {
    const common = [
      join(home, "Google Drive"),
      join(home, "gdrive"),
      join(home, "Drive"),
    ];
    for (const path of common) {
      if (seen.has(path) || !existsSync(path)) continue;
      roots.push({
        id: slug(path),
        label: basename(path),
        path,
        kind: "local",
        source: "auto",
        exists: true,
      });
      seen.add(path);
    }
  }

  return roots;
}
