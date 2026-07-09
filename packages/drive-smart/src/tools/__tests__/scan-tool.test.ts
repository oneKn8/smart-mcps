import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext, type DriveContext } from "../../context.js";
import { bytes } from "../../format.js";
import { tools } from "../index.js";

// drive_scan is an aggregate scanner: it walks config/local roots into the
// on-disk index and returns counts only (no SlimFile list). These are
// integration tests driven through real temp-dir filesystems.
const tool = tools.find(t => t.name === "drive_scan")!;

type ScanOutput = {
  index_path: string;
  generated_at: string;
  root_count: number;
  file_count: number;
  skipped_count: number;
  total_bytes: number;
  total_size: string;
};

const OUTPUT_KEYS = [
  "index_path",
  "generated_at",
  "root_count",
  "file_count",
  "skipped_count",
  "total_bytes",
  "total_size",
];

const FIXED_NOW = "2026-05-26T12:00:00.000Z";

// Each test allocates its own unique mkdtemp dir; all are torn down in afterEach.
const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-smart-scan-tool-"));
  tmpDirs.push(dir);
  return dir;
}

function stateDir(home: string): string {
  const dir = path.join(home, ".santo-agent", "drive-smart");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(home: string, config: unknown): void {
  fs.writeFileSync(path.join(stateDir(home), "config.json"), JSON.stringify(config));
}

type Base = { tmp: string; home: string; gvfsBase: string; ctx: DriveContext };

// Fresh home + an EMPTY gvfs base (a real temp dir, never a live FUSE mount).
function base(): Base {
  const tmp = makeTmp();
  const home = path.join(tmp, "home");
  const gvfsBase = path.join(tmp, "empty-gvfs");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(gvfsBase, { recursive: true });
  return { tmp, home, gvfsBase, ctx: buildContext({ home, gvfsBase }) };
}

// A local config root "data-root" with 3 files (12 bytes total) plus a
// node_modules dir that must be ignored, and a nested subdir.
function localFixture(): Base & { root: string } {
  const b = base();
  const root = path.join(b.tmp, "data");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "a.txt"), "AAAA"); // 4
  fs.writeFileSync(path.join(root, "b.log"), "BB"); // 2
  fs.writeFileSync(path.join(root, "sub", "c.pdf"), "CCCCCC"); // 6
  fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "XXXXXXXX"); // ignored
  writeConfig(b.home, { roots: [{ id: "data-root", path: root, kind: "local" }] });
  return { ...b, root };
}

// Local root (as above) plus a gvfs google-drive mount holding net.txt (3 bytes).
// The mount lives under the temp gvfs base; discovery slugs it to "alice-gmail-com".
function networkFixture(): Base & { root: string; netRootId: string } {
  const f = localFixture();
  const mount = path.join(f.gvfsBase, "google-drive:host=gmail.com,user=alice");
  fs.mkdirSync(mount, { recursive: true });
  fs.writeFileSync(path.join(mount, "net.txt"), "NET"); // 3
  return { ...f, netRootId: "alice-gmail-com" };
}

async function runScan(input: unknown, ctx: DriveContext): Promise<ScanOutput> {
  return (await tool.handler(tool.inputSchema.parse(input), ctx)) as ScanOutput;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  vi.useRealTimers();
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("drive_scan metadata", () => {
  it("exposes the exact tool name", () => {
    expect(tool.name).toBe("drive_scan");
  });

  it("has a non-empty string description", () => {
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
  });
});

describe("drive_scan schema", () => {
  it("rejects clearly invalid input", () => {
    expect(() => tool.inputSchema.parse({ max_depth: 51 })).toThrow();
    expect(() => tool.inputSchema.parse({ limit_files: 0 })).toThrow();
    expect(() => tool.inputSchema.parse({ root_ids: "not-an-array" })).toThrow();
  });

  it("resolves documented defaults when parsing {}", () => {
    const parsed = tool.inputSchema.parse({}) as {
      max_depth: number;
      limit_files: number;
      include_network_roots: boolean;
      root_ids?: string[];
    };
    expect(parsed.max_depth).toBe(12);
    expect(parsed.limit_files).toBe(100_000);
    expect(parsed.include_network_roots).toBe(false);
    expect(parsed.root_ids).toBeUndefined();
  });
});

describe("drive_scan output", () => {
  it("returns exactly the documented output keys and nothing else", async () => {
    const f = localFixture();
    const result = await runScan({}, f.ctx);
    expect(Object.keys(result).sort()).toEqual([...OUTPUT_KEYS].sort());
  });

  it("aggregates counts and byte totals over a local fixture", async () => {
    const f = localFixture();
    const result = await runScan({}, f.ctx);

    expect(result.root_count).toBe(1);
    expect(result.file_count).toBe(3);
    expect(result.skipped_count).toBe(0);
    expect(result.total_bytes).toBe(12);
    expect(result.total_size).toBe(bytes(12));
    expect(result.total_size).toBe("12 B");
    expect(result.generated_at).toBe(FIXED_NOW);
    expect(result.index_path).toBe(
      path.join(f.home, ".santo-agent", "drive-smart", "index.json"),
    );

    // The scan persisted the full index; its file records match the count.
    const persisted = JSON.parse(fs.readFileSync(result.index_path, "utf8")) as {
      files: unknown[];
    };
    expect(persisted.files).toHaveLength(3);
  });
});

describe("drive_scan ignore rules", () => {
  it("never counts files inside node_modules", async () => {
    const f = localFixture();
    // Add extra ignored payload to prove exclusion is by name, not by count.
    fs.writeFileSync(path.join(f.root, "node_modules", "more.js"), "YYYY");
    const result = await runScan({}, f.ctx);
    expect(result.file_count).toBe(3);
    expect(result.total_bytes).toBe(12);
  });
});

describe("drive_scan network roots", () => {
  it("skips gvfs network roots by default", async () => {
    const f = networkFixture();
    const result = await runScan({}, f.ctx);
    // Only the local root is walked; the mount is filtered out pre-walk.
    expect(result.root_count).toBe(1);
    expect(result.file_count).toBe(3);
    expect(result.total_bytes).toBe(12);
  });

  it("includes gvfs network roots when include_network_roots is true", async () => {
    const f = networkFixture();
    const result = await runScan({ include_network_roots: true }, f.ctx);
    expect(result.root_count).toBe(2);
    expect(result.file_count).toBe(4);
    expect(result.total_bytes).toBe(15);
    expect(result.total_size).toBe("15 B");
  });

  it("walks a network root when it is named explicitly in root_ids", async () => {
    const f = networkFixture();
    const result = await runScan({ root_ids: [f.netRootId] }, f.ctx);
    // Explicit naming opts the mount in and scopes out the local root.
    expect(result.root_count).toBe(1);
    expect(result.file_count).toBe(1);
    expect(result.total_bytes).toBe(3);
  });
});

describe("drive_scan root_ids scoping", () => {
  it("scopes the walk to a single named local root", async () => {
    const b = base();
    const rootA = path.join(b.tmp, "a");
    const rootB = path.join(b.tmp, "b");
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    fs.writeFileSync(path.join(rootA, "one.txt"), "1");
    fs.writeFileSync(path.join(rootA, "two.txt"), "22");
    fs.writeFileSync(path.join(rootB, "three.txt"), "333");
    writeConfig(b.home, {
      roots: [
        { id: "a-root", path: rootA, kind: "local" },
        { id: "b-root", path: rootB, kind: "local" },
      ],
    });

    const result = await runScan({ root_ids: ["a-root"] }, b.ctx);
    expect(result.root_count).toBe(1);
    expect(result.file_count).toBe(2);
    expect(result.total_bytes).toBe(3);
  });
});

describe("drive_scan empty inputs", () => {
  it("returns zeros when no config and no discoverable roots exist", async () => {
    const b = base();
    const result = await runScan({}, b.ctx);
    expect(result.root_count).toBe(0);
    expect(result.file_count).toBe(0);
    expect(result.skipped_count).toBe(0);
    expect(result.total_bytes).toBe(0);
    expect(result.total_size).toBe("0 B");
  });

  it("returns zero files for a configured but empty local root", async () => {
    const b = base();
    const root = path.join(b.tmp, "empty-root");
    fs.mkdirSync(root, { recursive: true });
    writeConfig(b.home, { roots: [{ id: "empty-root", path: root, kind: "local" }] });

    const result = await runScan({}, b.ctx);
    expect(result.root_count).toBe(1);
    expect(result.file_count).toBe(0);
    expect(result.total_bytes).toBe(0);
    expect(result.total_size).toBe("0 B");
  });
});

describe("drive_scan caps", () => {
  it("stops descending past max_depth and records the skip", async () => {
    const b = base();
    const root = path.join(b.tmp, "deep");
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "top.txt"), "T");
    fs.writeFileSync(path.join(root, "a", "mid.txt"), "M");
    fs.writeFileSync(path.join(root, "a", "b", "deep.txt"), "D");
    writeConfig(b.home, { roots: [{ id: "deep-root", path: root, kind: "local" }] });

    const result = await runScan({ max_depth: 1 }, b.ctx);
    // top.txt (depth 0) + mid.txt (depth 1) counted; the b/ dir at depth 2 skipped.
    expect(result.file_count).toBe(2);
    expect(result.skipped_count).toBe(1);
  });

  it("caps the number of indexed files at limit_files", async () => {
    const f = localFixture();
    const result = await runScan({ limit_files: 2 }, f.ctx);
    expect(result.file_count).toBe(2);
  });
});
