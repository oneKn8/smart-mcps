import { bytes } from "../format.js";
import { isGvfsPath } from "../roots.js";
import type { DriveRoot, DriveRootKind, IndexedFile } from "../types.js";

/**
 * Stable, slim projection of an indexed file returned by search/largest/
 * duplicates/plan_cleanup. Upstream-only bookkeeping fields (`root_id`,
 * `root_label`, `relative_path`, `modified_ms`, `kind`) are stripped so tool
 * outputs stay minimal. `account` is omitted when the file has none.
 */
export type SlimFile = {
  id: string;
  name: string;
  path: string;
  account?: string;
  size: number;
  size_human: string;
  extension: string;
};

export function mapFile(file: IndexedFile): SlimFile {
  return {
    id: file.id,
    name: file.name,
    path: file.path,
    ...(file.account ? { account: file.account } : {}),
    size: file.size,
    size_human: bytes(file.size),
    extension: file.extension,
  };
}

/**
 * Slim projection of a discovered root for `drive_roots`. `network` is true for
 * gvfs-mounted (network-backed) roots, which `drive_scan` skips by default.
 * `account` is omitted when the root has none.
 */
export type SlimRoot = {
  id: string;
  label: string;
  path: string;
  account?: string;
  kind: DriveRootKind;
  source: "config" | "auto";
  exists: boolean;
  network: boolean;
};

export function mapRoot(root: DriveRoot, gvfsBase?: string): SlimRoot {
  return {
    id: root.id,
    label: root.label,
    path: root.path,
    ...(root.account ? { account: root.account } : {}),
    kind: root.kind,
    source: root.source,
    exists: root.exists,
    network: isGvfsPath(root.path, gvfsBase),
  };
}
