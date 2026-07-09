import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext, type DriveContext } from "../../context.js";
import type { DriveIndex, IndexedFile } from "../../types.js";
import { drivePlanCleanup } from "../cleanup.js";

const MB = 1024 * 1024;
const DEFAULT_MIN_SIZE = 100 * MB; // 104857600
const SLIM_FILE_KEYS = ["account", "extension", "id", "name", "path", "size", "size_human"];

let tmp: string;
let fileCounter = 0;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-smart-cleanup-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stateDir(): string {
  return path.join(tmp, ".santo-agent", "drive-smart");
}

function file(overrides: Partial<IndexedFile> = {}): IndexedFile {
  fileCounter += 1;
  const name = overrides.name ?? `file-${fileCounter}.bin`;
  return {
    id: `root:${name}`,
    root_id: "root",
    root_label: "Root",
    path: `/data/${name}`,
    relative_path: name,
    name,
    extension: path.extname(name).toLowerCase(),
    size: 200 * MB,
    modified_ms: 1_700_000_000_000,
    kind: "file",
    ...overrides,
  };
}

function writeIndex(files: IndexedFile[]): void {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const index: DriveIndex = {
    version: 1,
    generated_at: "2026-05-26T12:00:00.000Z",
    roots: [],
    files,
    skipped: [],
  };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
}

function makeCtx(): DriveContext {
  return buildContext({ home: tmp, gvfsBase: path.join(tmp, "empty-gvfs") });
}

function run(input: Record<string, unknown> = {}) {
  return drivePlanCleanup.handler(
    drivePlanCleanup.inputSchema.parse(input),
    makeCtx(),
  );
}

describe("drive_plan_cleanup metadata", () => {
  it("has the exact tool name", () => {
    expect(drivePlanCleanup.name).toBe("drive_plan_cleanup");
  });

  it("has a non-empty string description", () => {
    expect(typeof drivePlanCleanup.description).toBe("string");
    expect(drivePlanCleanup.description.length).toBeGreaterThan(0);
  });
});

describe("drive_plan_cleanup schema", () => {
  it("rejects an unknown strategy and out-of-range numbers", () => {
    expect(() => drivePlanCleanup.inputSchema.parse({ strategy: "bogus" })).toThrow();
    expect(() => drivePlanCleanup.inputSchema.parse({ limit: 0 })).toThrow();
    expect(() => drivePlanCleanup.inputSchema.parse({ limit: 501 })).toThrow();
    expect(() => drivePlanCleanup.inputSchema.parse({ min_size: -1 })).toThrow();
  });

  it("resolves documented defaults when given an empty object", () => {
    expect(drivePlanCleanup.inputSchema.parse({})).toEqual({
      strategy: "large_files",
      min_size: DEFAULT_MIN_SIZE,
      limit: 50,
    });
  });
});

describe("drive_plan_cleanup output shape", () => {
  it("returns exactly the documented top-level keys", async () => {
    writeIndex([file({ size: 300 * MB })]);
    const result = await run({ strategy: "large_files" });
    expect(Object.keys(result).sort()).toEqual(
      ["candidates", "count", "dry_run", "strategy", "total_bytes", "total_size"].sort(),
    );
  });

  it("emits candidates as slim files with no leaked index bookkeeping", async () => {
    writeIndex([
      file({ name: "video.bin", size: 300 * MB, account: "alpha@example.com" }),
    ]);
    const result = await run({ strategy: "large_files" });
    const candidate = result.candidates[0]!;
    expect(Object.keys(candidate).sort()).toEqual(SLIM_FILE_KEYS.sort());
    for (const leaked of ["root_id", "root_label", "relative_path", "modified_ms", "kind"]) {
      expect(candidate).not.toHaveProperty(leaked);
    }
  });
});

describe("drive_plan_cleanup dry-run invariant", () => {
  it("always reports dry_run true across every strategy", async () => {
    writeIndex([
      file({ name: "clip.mp4", path: "/media/clip.mp4", size: 10 }),
      file({ name: "bundle.zip", path: "/dl/bundle.zip", size: 10 }),
      file({ name: "lib.js", path: "/proj/node_modules/lib.js", size: 10 }),
      file({ name: "big.bin", path: "/data/big.bin", size: 500 * MB }),
    ]);
    for (const strategy of ["large_files", "archives", "media", "caches"]) {
      const result = await run({ strategy, min_size: 0 });
      expect(result.dry_run).toBe(true);
      expect(result.strategy).toBe(strategy);
    }
  });

  it("does not mutate the index or the filesystem", async () => {
    writeIndex([file({ name: "big.bin", path: "/data/big.bin", size: 300 * MB })]);
    const indexFile = path.join(stateDir(), "index.json");
    const before = fs.readFileSync(indexFile, "utf8");
    const dirBefore = fs.readdirSync(stateDir()).sort();

    const result = await run({ strategy: "large_files" });
    expect(result.count).toBe(1);

    expect(fs.readFileSync(indexFile, "utf8")).toBe(before);
    expect(fs.readdirSync(stateDir()).sort()).toEqual(dirBefore);
    expect(fs.existsSync("/data/big.bin")).toBe(false);
  });
});

describe("drive_plan_cleanup strategy filters", () => {
  it("large_files ranks by size desc and drops files under min_size", async () => {
    writeIndex([
      file({ name: "small.bin", size: 50 * MB }),
      file({ name: "medium.bin", size: 150 * MB }),
      file({ name: "under.bin", size: 99 * MB }),
      file({ name: "huge.bin", size: 300 * MB }),
    ]);
    const result = await run({ strategy: "large_files" });
    expect(result.count).toBe(2);
    expect(result.candidates.map(c => c.name)).toEqual(["huge.bin", "medium.bin"]);
    expect(result.total_bytes).toBe(300 * MB + 150 * MB);
  });

  it("archives keeps only archive extensions", async () => {
    writeIndex([
      file({ name: "a.zip", size: 10 }),
      file({ name: "b.tar", size: 10 }),
      file({ name: "c.pdf", size: 10 }),
      file({ name: "d.mp4", size: 10 }),
    ]);
    const result = await run({ strategy: "archives", min_size: 0 });
    expect(result.candidates.map(c => c.name).sort()).toEqual(["a.zip", "b.tar"]);
    for (const candidate of result.candidates) {
      expect([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"]).toContain(candidate.extension);
    }
  });

  it("media keeps only audio/video extensions", async () => {
    writeIndex([
      file({ name: "movie.mp4", size: 10 }),
      file({ name: "song.flac", size: 10 }),
      file({ name: "pack.zip", size: 10 }),
      file({ name: "notes.txt", size: 10 }),
    ]);
    const result = await run({ strategy: "media", min_size: 0 });
    expect(result.candidates.map(c => c.name).sort()).toEqual(["movie.mp4", "song.flac"]);
  });

  it("caches keeps only cache-ish paths", async () => {
    writeIndex([
      file({ name: "lib.js", path: "/proj/node_modules/lib.js", size: 10 }),
      file({ name: "blob.dat", path: "/home/.cache/blob.dat", size: 10 }),
      file({ name: "bundle.js", path: "/proj/dist/bundle.js", size: 10 }),
      file({ name: "lcov.info", path: "/proj/coverage/lcov.info", size: 10 }),
      file({ name: "report.pdf", path: "/home/docs/report.pdf", size: 10 }),
    ]);
    const result = await run({ strategy: "caches", min_size: 0 });
    expect(result.candidates.map(c => c.name).sort()).toEqual([
      "blob.dat",
      "bundle.js",
      "lcov.info",
      "lib.js",
    ]);
    expect(result.candidates.map(c => c.name)).not.toContain("report.pdf");
  });
});

describe("drive_plan_cleanup bounds and edges", () => {
  it("applies a custom min_size cutoff over the default", async () => {
    writeIndex([
      file({ name: "big.bin", size: 300 * MB }),
      file({ name: "mid.bin", size: 100 * MB }),
    ]);
    const result = await run({ strategy: "large_files", min_size: 200 * MB });
    expect(result.count).toBe(1);
    expect(result.candidates.map(c => c.name)).toEqual(["big.bin"]);
  });

  it("caps candidates at limit and keeps the largest", async () => {
    writeIndex([
      file({ name: "a.bin", size: 500 * MB }),
      file({ name: "b.bin", size: 400 * MB }),
      file({ name: "c.bin", size: 300 * MB }),
      file({ name: "d.bin", size: 200 * MB }),
    ]);
    const result = await run({ strategy: "large_files", limit: 2 });
    expect(result.count).toBe(2);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(c => c.name)).toEqual(["a.bin", "b.bin"]);
  });

  it("returns zeros for an absent index", async () => {
    const result = await run({ strategy: "large_files" });
    expect(result).toEqual({
      dry_run: true,
      strategy: "large_files",
      count: 0,
      total_bytes: 0,
      total_size: "0 B",
      candidates: [],
    });
  });
});
