import { loadConfig } from "./config.js";
import { loadIndex, saveIndex } from "./index-store.js";
import { discoverRoots, isGvfsPath } from "./roots.js";
import { scanRoots } from "./scan.js";

export interface DriveContext {
  /** Home directory for locating the persistent state dir and common local roots. */
  home?: string;
  /** gvfs mount base, e.g. `/run/user/1000/gvfs`. Injected so tests can point discovery at a temp dir with no real mount. */
  gvfsBase?: string;
}

export type ScanRequest = {
  maxDepth?: number;
  limitFiles?: number;
  rootIds?: string[];
  includeNetworkRoots?: boolean;
};

/**
 * Build the production context. Defaults `home` to `process.env.HOME` and
 * `gvfsBase` to the real per-user gvfs mount base so production behaviour is
 * unchanged; callers (tests) can override either field.
 */
export function buildContext(overrides: Partial<DriveContext> = {}): DriveContext {
  const uid = process.getuid?.() ?? 1000;
  return {
    home: overrides.home ?? process.env.HOME,
    gvfsBase: overrides.gvfsBase ?? `/run/user/${uid}/gvfs`,
  };
}

export function services(ctx: DriveContext) {
  const config = loadConfig(ctx.home);
  const discover = () =>
    discoverRoots(config, { gvfsBase: ctx.gvfsBase, home: ctx.home });
  return {
    config,
    gvfsBase: ctx.gvfsBase,
    roots: () => discover(),
    loadIndex: () => loadIndex(ctx.home),
    scan: (req: ScanRequest = {}) => {
      const named =
        req.rootIds && req.rootIds.length > 0 ? new Set(req.rootIds) : undefined;
      // Filter the discovered roots BEFORE any filesystem walk. `root_ids`
      // scopes first; network (gvfs) roots are then skipped unless the caller
      // opts in globally (`includeNetworkRoots`) or names the root explicitly.
      const roots = discover().filter(root => {
        if (named && !named.has(root.id)) return false;
        if (!isGvfsPath(root.path, ctx.gvfsBase)) return true;
        if (req.includeNetworkRoots) return true;
        if (named && named.has(root.id)) return true;
        return false;
      });
      const index = scanRoots({
        roots,
        maxDepth: req.maxDepth,
        limitFiles: req.limitFiles,
        ignoreNames: config.ignore_names,
      });
      const path = saveIndex(index, ctx.home);
      return { index, path };
    },
  };
}
