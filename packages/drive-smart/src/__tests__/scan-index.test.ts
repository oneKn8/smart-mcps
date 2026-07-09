import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ValidationError } from "smart-mcp-core";
import { loadConfig } from "../config.js";
import { buildContext, services } from "../context.js";
import { loadIndex, saveIndex } from "../index-store.js";
import { scanRoots } from "../scan.js";
import type { DriveRoot } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-smart-test-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function root(overrides: Partial<DriveRoot> = {}): DriveRoot {
  return {
    id: "root",
    label: "Root",
    path: tmpDir,
    kind: "local",
    source: "config",
    exists: true,
    ...overrides,
  };
}

describe("scanRoots", () => {
  it("indexes files with root metadata, relative paths, lowercase extensions, and sizes", () => {
    const nested = path.join(tmpDir, "Projects");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(tmpDir, "README.MD"), "hello");
    fs.writeFileSync(path.join(nested, "Plan.PDF"), "1234567890");

    const index = scanRoots({
      roots: [root({ account: "alice@example.com" })],
    });

    expect(index.generated_at).toBe("2026-05-26T12:00:00.000Z");
    expect(index.skipped).toEqual([]);
    expect(index.files.map(file => file.relative_path).sort()).toEqual([
      "Projects/Plan.PDF",
      "README.MD",
    ]);
    expect(index.files).toContainEqual(
      expect.objectContaining({
        id: "root:README.MD",
        root_id: "root",
        root_label: "Root",
        account: "alice@example.com",
        path: path.join(tmpDir, "README.MD"),
        name: "README.MD",
        extension: ".md",
        size: 5,
        kind: "file",
      }),
    );
  });

  it("ignores default and configured directory names", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.mkdirSync(path.join(tmpDir, "skip-me"));
    fs.writeFileSync(path.join(tmpDir, ".git", "config"), "secret");
    fs.writeFileSync(path.join(tmpDir, "skip-me", "hidden.txt"), "hidden");
    fs.writeFileSync(path.join(tmpDir, "visible.txt"), "visible");

    const index = scanRoots({
      roots: [root()],
      ignoreNames: ["skip-me"],
    });

    expect(index.files.map(file => file.relative_path)).toEqual(["visible.txt"]);
  });

  it("respects maxDepth and limitFiles", () => {
    const deep = path.join(tmpDir, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "one.txt"), "1");
    fs.writeFileSync(path.join(tmpDir, "two.txt"), "2");
    fs.writeFileSync(path.join(deep, "deep.txt"), "deep");

    const depthLimited = scanRoots({ roots: [root()], maxDepth: 1 });
    expect(depthLimited.files.map(file => file.relative_path).sort()).toEqual([
      "one.txt",
      "two.txt",
    ]);
    expect(depthLimited.skipped).toEqual([
      { path: path.join(tmpDir, "a", "b"), reason: "max_depth" },
    ]);

    const fileLimited = scanRoots({ roots: [root()], limitFiles: 1 });
    expect(fileLimited.files).toHaveLength(1);
  });

  it("skips roots marked as missing", () => {
    fs.writeFileSync(path.join(tmpDir, "visible.txt"), "visible");

    const index = scanRoots({
      roots: [root({ exists: false })],
    });

    expect(index.files).toEqual([]);
    expect(index.skipped).toEqual([]);
  });

  it("returns empty files and skipped for an empty root", () => {
    const index = scanRoots({ roots: [root()] });
    expect(index.files).toEqual([]);
    expect(index.skipped).toEqual([]);
  });

  it("skips symlinked directories and does not follow them into a cycle", () => {
    const sub = path.join(tmpDir, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "file.txt"), "real");
    // A self-referential directory symlink: following it would re-walk to
    // maxDepth. It must be skipped, not descended.
    fs.symlinkSync(tmpDir, path.join(tmpDir, "loop"), "dir");

    const index = scanRoots({ roots: [root()], maxDepth: 20 });

    expect(index.files.map(file => file.relative_path)).toEqual(["sub/file.txt"]);
    expect(index.skipped).toEqual([
      { path: path.join(tmpDir, "loop"), reason: "symlinked_dir" },
    ]);
  });

  it("indexes symlinked files by their target", () => {
    fs.writeFileSync(path.join(tmpDir, "target.txt"), "1234567890");
    fs.symlinkSync(path.join(tmpDir, "target.txt"), path.join(tmpDir, "alias.txt"), "file");

    const index = scanRoots({ roots: [root()] });

    expect(index.files.map(file => file.relative_path).sort()).toEqual([
      "alias.txt",
      "target.txt",
    ]);
    const alias = index.files.find(file => file.relative_path === "alias.txt");
    expect(alias?.size).toBe(10);
    expect(alias?.kind).toBe("file");
  });

  it("records permission errors mid-walk in skipped and keeps indexing siblings", () => {
    fs.writeFileSync(path.join(tmpDir, "visible.txt"), "ok");
    const locked = path.join(tmpDir, "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "secret.txt"), "nope");
    fs.chmodSync(locked, 0o000);
    try {
      const index = scanRoots({ roots: [root()] });
      expect(index.files.map(file => file.relative_path)).toEqual(["visible.txt"]);
      expect(index.skipped).toHaveLength(1);
      expect(index.skipped[0]?.path).toBe(locked);
      expect(index.skipped[0]?.reason).toMatch(/EACCES|permission denied/i);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe("index store", () => {
  it("returns an empty index when no persisted index exists", () => {
    expect(loadIndex(tmpDir)).toEqual({
      version: 1,
      generated_at: "1970-01-01T00:00:00.000Z",
      roots: [],
      files: [],
      skipped: [],
    });
  });

  it("persists and reloads an index under the drive-smart state directory", () => {
    const index = scanRoots({ roots: [root()] });
    const savedPath = saveIndex(index, tmpDir);

    expect(savedPath).toBe(
      path.join(tmpDir, ".santo-agent", "drive-smart", "index.json"),
    );
    expect(loadIndex(tmpDir)).toEqual(index);
  });
});

describe("json guards", () => {
  it("throws ValidationError naming the corrupt index file", () => {
    const dir = path.join(tmpDir, ".santo-agent", "drive-smart");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "index.json");
    fs.writeFileSync(file, "{ not valid json");

    expect(() => loadIndex(tmpDir)).toThrow(ValidationError);
    expect(() => loadIndex(tmpDir)).toThrow(file);
  });

  it("throws ValidationError naming the corrupt config file", () => {
    const dir = path.join(tmpDir, ".santo-agent", "drive-smart");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "not json at all");

    expect(() => loadConfig(tmpDir)).toThrow(ValidationError);
    expect(() => loadConfig(tmpDir)).toThrow(file);
  });
});

describe("services scan scoping", () => {
  let home: string;
  let gvfsBase: string;
  let localDir: string;
  let netFile: string;
  let localFile: string;
  const gvfsRootId = "alice-gmail-com";

  beforeEach(() => {
    home = path.join(tmpDir, "home");
    gvfsBase = path.join(tmpDir, "gvfs");
    localDir = path.join(tmpDir, "local");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(gvfsBase, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });

    // A local (non-network) config root.
    localFile = path.join(localDir, "local.txt");
    fs.writeFileSync(localFile, "local");
    const stateDir = path.join(home, ".santo-agent", "drive-smart");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({ roots: [{ id: "local-root", path: localDir, kind: "local" }] }),
    );

    // A gvfs (network) mount with a file that must not be walked by default.
    const mount = path.join(gvfsBase, "google-drive:host=gmail.com,user=alice");
    fs.mkdirSync(mount, { recursive: true });
    netFile = path.join(mount, "net.txt");
    fs.writeFileSync(netFile, "network");
  });

  function ctx() {
    return buildContext({ home, gvfsBase });
  }

  function relPaths(paths: string[]): string[] {
    return paths.map(p => path.basename(p)).sort();
  }

  it("marks the gvfs mount as a network root in discovery", () => {
    const roots = services(ctx()).roots();
    const gvfs = roots.find(r => r.id === gvfsRootId);
    expect(gvfs?.kind).toBe("google-drive");
    expect(gvfs?.source).toBe("auto");
  });

  it("scans local/config roots but skips network roots by default", () => {
    const { index } = services(ctx()).scan();
    expect(relPaths(index.files.map(f => f.path))).toEqual(["local.txt"]);
  });

  it("includes network roots when include_network_roots is set", () => {
    const { index } = services(ctx()).scan({ includeNetworkRoots: true });
    expect(relPaths(index.files.map(f => f.path))).toEqual(["local.txt", "net.txt"]);
  });

  it("walks a network root when it is named explicitly in root_ids", () => {
    const { index } = services(ctx()).scan({ rootIds: [gvfsRootId] });
    expect(relPaths(index.files.map(f => f.path))).toEqual(["net.txt"]);
  });

  it("scopes to named local roots before any walk", () => {
    const { index } = services(ctx()).scan({ rootIds: ["local-root"] });
    expect(relPaths(index.files.map(f => f.path))).toEqual(["local.txt"]);
  });
});
