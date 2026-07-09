import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext } from "../../context.js";
import type { DriveContext } from "../../context.js";
import { driveStats } from "../stats.js";
import type { DriveIndex, DriveRoot, IndexedFile } from "../../types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-smart-stats-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// gvfsBase points at an empty temp dir, never a real mount. drive_stats reads
// only the persisted index, so discovery never walks it, but we honor the
// contract anyway.
function ctx(): DriveContext {
  return buildContext({ home: tmp, gvfsBase: path.join(tmp, "empty-gvfs") });
}

function file(overrides: Partial<IndexedFile> = {}): IndexedFile {
  return {
    id: "root-a:file.txt",
    root_id: "root-a",
    root_label: "Alpha",
    path: "/data/file.txt",
    relative_path: "file.txt",
    name: "file.txt",
    extension: ".txt",
    size: 1,
    modified_ms: 1_700_000_000_000,
    kind: "file",
    ...overrides,
  };
}

function driveRoot(overrides: Partial<DriveRoot> = {}): DriveRoot {
  return {
    id: "root-a",
    label: "Alpha",
    path: "/data",
    kind: "local",
    source: "config",
    exists: true,
    ...overrides,
  };
}

function makeIndex(
  files: IndexedFile[],
  opts: {
    generated_at?: string;
    roots?: DriveRoot[];
    skipped?: DriveIndex["skipped"];
  } = {},
): DriveIndex {
  return {
    version: 1,
    generated_at: opts.generated_at ?? "2026-06-01T00:00:00.000Z",
    roots: opts.roots ?? [],
    files,
    skipped: opts.skipped ?? [],
  };
}

function writeIndex(index: DriveIndex): void {
  const dir = path.join(tmp, ".santo-agent", "drive-smart");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
}

function run() {
  return driveStats.handler(driveStats.inputSchema.parse({}), ctx());
}

// A fixture spanning two roots and three extension buckets. Expected aggregates
// are pinned exactly below.
//   root-a "Alpha" (account alpha@example.com): .pdf 1000, .pdf 500, .txt 2000
//   root-b "Beta"  (no account):                .txt 100,  (none) 300
function mixedIndex(): DriveIndex {
  return makeIndex(
    [
      file({ id: "a1", root_id: "root-a", root_label: "Alpha", account: "alpha@example.com", extension: ".pdf", size: 1000 }),
      file({ id: "a2", root_id: "root-a", root_label: "Alpha", account: "alpha@example.com", extension: ".pdf", size: 500 }),
      file({ id: "a3", root_id: "root-a", root_label: "Alpha", account: "alpha@example.com", extension: ".txt", size: 2000 }),
      file({ id: "b1", root_id: "root-b", root_label: "Beta", extension: ".txt", size: 100 }),
      file({ id: "b2", root_id: "root-b", root_label: "Beta", extension: "", size: 300 }),
    ],
    {
      roots: [
        driveRoot({ id: "root-a", label: "Alpha", account: "alpha@example.com" }),
        driveRoot({ id: "root-b", label: "Beta", path: "/beta" }),
      ],
      skipped: [{ path: "/data/locked", reason: "EACCES: permission denied" }],
    },
  );
}

describe("drive_stats metadata", () => {
  it("has the exact tool name and a non-empty description", () => {
    expect(driveStats.name).toBe("drive_stats");
    expect(typeof driveStats.description).toBe("string");
    expect(driveStats.description.length).toBeGreaterThan(0);
  });
});

describe("drive_stats schema", () => {
  it("parses empty input to an empty object (no required fields)", () => {
    expect(driveStats.inputSchema.parse({})).toEqual({});
  });

  it("rejects a clearly non-object input", () => {
    expect(() => driveStats.inputSchema.parse(null)).toThrow();
    expect(() => driveStats.inputSchema.parse(42)).toThrow();
  });
});

describe("drive_stats output", () => {
  it("returns only the documented top-level keys", async () => {
    writeIndex(mixedIndex());
    const result = await run();
    expect(Object.keys(result).sort()).toEqual(
      [
        "generated_at",
        "root_count",
        "file_count",
        "skipped_count",
        "total_bytes",
        "total_size",
        "by_root",
        "by_extension",
      ].sort(),
    );
  });

  it("aggregates counts, bytes, and human sizes across the index", async () => {
    writeIndex(mixedIndex());
    const result = await run();
    expect(result.generated_at).toBe("2026-06-01T00:00:00.000Z");
    expect(result.root_count).toBe(2);
    expect(result.file_count).toBe(5);
    expect(result.skipped_count).toBe(1);
    expect(result.total_bytes).toBe(3900);
    expect(result.total_size).toBe("3.8 KB");
  });

  it("groups by root, sorted by bytes desc, with account only when present", async () => {
    writeIndex(mixedIndex());
    const result = await run();
    expect(result.by_root).toEqual([
      {
        root_id: "root-a",
        root_label: "Alpha",
        account: "alpha@example.com",
        file_count: 3,
        total_bytes: 3500,
        total_size: "3.4 KB",
      },
      {
        root_id: "root-b",
        root_label: "Beta",
        file_count: 2,
        total_bytes: 400,
        total_size: "400 B",
      },
    ]);
    // account is omitted, not null/undefined, for the accountless root.
    expect(Object.keys(result.by_root[1]!).sort()).toEqual(
      ["file_count", "root_id", "root_label", "total_bytes", "total_size"].sort(),
    );
  });

  it("groups by extension, sorted by bytes desc, bucketing missing extensions as (none)", async () => {
    writeIndex(mixedIndex());
    const result = await run();
    expect(result.by_extension).toEqual([
      { extension: ".txt", file_count: 2, total_bytes: 2100, total_size: "2.1 KB" },
      { extension: ".pdf", file_count: 2, total_bytes: 1500, total_size: "1.5 KB" },
      { extension: "(none)", file_count: 1, total_bytes: 300, total_size: "300 B" },
    ]);
  });

  it("does not leak IndexedFile bookkeeping fields into grouped rows", async () => {
    writeIndex(mixedIndex());
    const result = await run();
    const rootRow = result.by_root[0]!;
    const extRow = result.by_extension[0]!;
    for (const leaked of ["relative_path", "modified_ms", "kind", "path", "name", "id", "size"]) {
      expect(rootRow).not.toHaveProperty(leaked);
    }
    for (const leaked of ["relative_path", "modified_ms", "kind", "path", "name", "id", "root_id", "root_label", "size"]) {
      expect(extRow).not.toHaveProperty(leaked);
    }
  });
});

describe("drive_stats edge cases", () => {
  it("returns zeros and empty groups for a missing index", async () => {
    // No index.json written -> loadIndex falls back to the epoch empty index.
    const result = await run();
    expect(result).toEqual({
      generated_at: "1970-01-01T00:00:00.000Z",
      root_count: 0,
      file_count: 0,
      skipped_count: 0,
      total_bytes: 0,
      total_size: "0 B",
      by_root: [],
      by_extension: [],
    });
  });

  it("counts roots and skipped entries even when there are no files", async () => {
    writeIndex(
      makeIndex([], {
        roots: [driveRoot({ id: "root-a" }), driveRoot({ id: "root-b", path: "/beta" })],
        skipped: [
          { path: "/data/locked", reason: "EACCES" },
          { path: "/data/deep", reason: "max_depth" },
        ],
      }),
    );
    const result = await run();
    expect(result.root_count).toBe(2);
    expect(result.file_count).toBe(0);
    expect(result.skipped_count).toBe(2);
    expect(result.total_bytes).toBe(0);
    expect(result.total_size).toBe("0 B");
    expect(result.by_root).toEqual([]);
    expect(result.by_extension).toEqual([]);
  });

  it("caps by_extension at 50 groups, keeping the largest by bytes", async () => {
    // 60 distinct single-file extensions; size grows with index so the 10
    // smallest are dropped by the slice(0, 50) cap and the largest leads.
    const files = Array.from({ length: 60 }, (_, i) =>
      file({ id: `f${i}`, extension: `.ext${i}`, size: i + 1 }),
    );
    writeIndex(makeIndex(files));
    const result = await run();
    expect(result.file_count).toBe(60);
    expect(result.by_extension).toHaveLength(50);
    expect(result.by_extension[0]!.extension).toBe(".ext59");
    expect(result.by_extension[49]!.extension).toBe(".ext10");
  });
});
