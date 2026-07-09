import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext, type DriveContext } from "../../context.js";
import { driveDuplicates } from "../duplicates.js";
import type { IndexedFile } from "../../types.js";

// Integration-style: drive the real tool handler against a temp
// `~/.santo-agent/drive-smart/index.json` fixture. drive_duplicates only reads
// the persistent index (never touches gvfs), but gvfsBase is still pointed at an
// empty temp dir so discovery can never reach a real mount.

const SLIM_FILE_KEYS = ["id", "name", "path", "size", "size_human", "extension"].sort();
const GROUP_KEYS = ["duplicate_count", "size_bytes", "size", "files"].sort();

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-smart-duplicates-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function file(overrides: Partial<IndexedFile>): IndexedFile {
  return {
    id: "id",
    root_id: "r1",
    root_label: "Root One",
    path: "/root/file",
    relative_path: "file",
    name: "file",
    extension: "",
    size: 0,
    modified_ms: 1_700_000_000_000,
    kind: "file",
    ...overrides,
  };
}

/**
 * A fixture exercising both grouping modes:
 * - report.pdf + Report.PDF (size 1000): a same-name (case-insensitive) + same-size pair, WITH account.
 * - photo.jpg x3 (size 5000): a same-name + same-size trio, NO account.
 * - alpha.bin (size 5000): same size as the photos, different name -> only groups under same_size.
 * - unique.txt (size 42): a singleton, never grouped.
 * - tiny.txt x2 (size 0): zero-byte duplicates, skipped unless min_size is 0.
 */
function fixtureFiles(): IndexedFile[] {
  return [
    file({ id: "r1:a/report.pdf", name: "report.pdf", path: "/root/a/report.pdf", relative_path: "a/report.pdf", extension: ".pdf", size: 1000, account: "alpha@example.com" }),
    file({ id: "r1:b/Report.PDF", name: "Report.PDF", path: "/root/b/Report.PDF", relative_path: "b/Report.PDF", extension: ".pdf", size: 1000, account: "alpha@example.com" }),
    file({ id: "r1:photo.jpg", name: "photo.jpg", path: "/root/photo.jpg", relative_path: "photo.jpg", extension: ".jpg", size: 5000 }),
    file({ id: "r1:copy/photo.jpg", name: "photo.jpg", path: "/root/copy/photo.jpg", relative_path: "copy/photo.jpg", extension: ".jpg", size: 5000 }),
    file({ id: "r1:copy2/photo.jpg", name: "photo.jpg", path: "/root/copy2/photo.jpg", relative_path: "copy2/photo.jpg", extension: ".jpg", size: 5000 }),
    file({ id: "r1:alpha.bin", name: "alpha.bin", path: "/root/alpha.bin", relative_path: "alpha.bin", extension: ".bin", size: 5000 }),
    file({ id: "r1:unique.txt", name: "unique.txt", path: "/root/unique.txt", relative_path: "unique.txt", extension: ".txt", size: 42 }),
    file({ id: "r1:tiny.txt", name: "tiny.txt", path: "/root/tiny.txt", relative_path: "tiny.txt", extension: ".txt", size: 0 }),
    file({ id: "r1:dir/tiny.txt", name: "tiny.txt", path: "/root/dir/tiny.txt", relative_path: "dir/tiny.txt", extension: ".txt", size: 0 }),
  ];
}

function writeIndex(files: IndexedFile[]): DriveContext {
  const stateDir = path.join(tmp, ".santo-agent", "drive-smart");
  fs.mkdirSync(stateDir, { recursive: true });
  const index = {
    version: 1,
    generated_at: "2026-05-26T12:00:00.000Z",
    roots: [],
    files,
    skipped: [],
  };
  fs.writeFileSync(path.join(stateDir, "index.json"), JSON.stringify(index));
  const emptyGvfs = path.join(tmp, "empty-gvfs");
  fs.mkdirSync(emptyGvfs, { recursive: true });
  return buildContext({ home: tmp, gvfsBase: emptyGvfs });
}

async function run(input: unknown, ctx: DriveContext) {
  return driveDuplicates.handler(driveDuplicates.inputSchema.parse(input) as never, ctx);
}

describe("drive_duplicates metadata", () => {
  it("has the exact tool name", () => {
    expect(driveDuplicates.name).toBe("drive_duplicates");
  });

  it("has a non-empty string description", () => {
    expect(typeof driveDuplicates.description).toBe("string");
    expect(driveDuplicates.description.length).toBeGreaterThan(0);
  });
});

describe("drive_duplicates schema", () => {
  it("rejects clearly-invalid inputs", () => {
    expect(() => driveDuplicates.inputSchema.parse({ mode: "nope" })).toThrow();
    expect(() => driveDuplicates.inputSchema.parse({ limit_groups: 0 })).toThrow();
    expect(() => driveDuplicates.inputSchema.parse({ limit_groups: 201 })).toThrow();
    expect(() => driveDuplicates.inputSchema.parse({ min_size: -1 })).toThrow();
    expect(() => driveDuplicates.inputSchema.parse({ min_size: 1.5 })).toThrow();
  });

  it("resolves documented defaults for empty input", () => {
    expect(driveDuplicates.inputSchema.parse({})).toEqual({
      mode: "same_name_and_size",
      min_size: 1,
      limit_groups: 50,
    });
  });
});

describe("drive_duplicates output shape", () => {
  it("returns exactly group_count and groups at the top level", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({}, ctx);
    expect(Object.keys(result).sort()).toEqual(["group_count", "groups"].sort());
  });

  it("emits slim files with no leak of index bookkeeping fields", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({}, ctx);
    // groups[0] is the account-less photo trio: clean slim strip.
    const group = result.groups[0]!;
    expect(Object.keys(group).sort()).toEqual(GROUP_KEYS);
    const slim = group.files[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_FILE_KEYS);
    for (const leak of ["root_id", "root_label", "relative_path", "modified_ms", "kind"]) {
      expect(slim).not.toHaveProperty(leak);
    }
  });

  it("passes through account when the indexed file has one", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({}, ctx);
    // groups[1] is the report.pdf pair, both carrying an account.
    const reportFile = result.groups[1]!.files[0]!;
    expect(reportFile).toHaveProperty("account", "alpha@example.com");
    expect(Object.keys(reportFile).sort()).toEqual([...SLIM_FILE_KEYS, "account"].sort());
  });
});

describe("drive_duplicates same_name_and_size (default)", () => {
  it("groups by lowercased name plus size, largest wasted bytes first", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({}, ctx);

    expect(result.group_count).toBe(2);
    // photo trio (5000*3=15000) outranks the report pair (1000*2=2000).
    expect(result.groups[0]).toMatchObject({
      duplicate_count: 3,
      size_bytes: 5000,
      size: "4.9 KB",
    });
    expect(result.groups[0]!.files.map(f => f.name)).toEqual(["photo.jpg", "photo.jpg", "photo.jpg"]);
    expect(result.groups[1]).toMatchObject({
      duplicate_count: 2,
      size_bytes: 1000,
      size: "1000 B",
    });
    // Case-insensitive name match: report.pdf and Report.PDF land together.
    expect(result.groups[1]!.files.map(f => f.name).sort()).toEqual(["Report.PDF", "report.pdf"]);
  });

  it("excludes singletons (unique name or unique size)", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({}, ctx);
    const names = result.groups.flatMap(g => g.files.map(f => f.name));
    expect(names).not.toContain("alpha.bin");
    expect(names).not.toContain("unique.txt");
  });
});

describe("drive_duplicates same_size mode", () => {
  it("groups purely by size, ignoring names", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({ mode: "same_size" }, ctx);

    expect(result.group_count).toBe(2);
    // size 5000 now sweeps in alpha.bin -> count 4 (vs 3 under same_name mode).
    expect(result.groups[0]).toMatchObject({ duplicate_count: 4, size_bytes: 5000 });
    expect(result.groups[0]!.files.map(f => f.name).sort()).toEqual([
      "alpha.bin",
      "photo.jpg",
      "photo.jpg",
      "photo.jpg",
    ]);
    expect(result.groups[1]).toMatchObject({ duplicate_count: 2, size_bytes: 1000 });
  });
});

describe("drive_duplicates min_size", () => {
  it("skips zero-byte duplicates under the default cutoff", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({}, ctx);
    const names = result.groups.flatMap(g => g.files.map(f => f.name));
    expect(names).not.toContain("tiny.txt");
  });

  it("includes zero-byte duplicates when min_size is 0", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({ min_size: 0 }, ctx);
    expect(result.group_count).toBe(3);
    const tiny = result.groups.find(g => g.files.every(f => f.name === "tiny.txt"));
    expect(tiny).toMatchObject({ duplicate_count: 2, size_bytes: 0, size: "0 B" });
  });

  it("filters out groups whose size falls below min_size", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({ min_size: 2000 }, ctx);
    // Only the 5000-byte photos survive; report (1000) and the rest are gone.
    expect(result.group_count).toBe(1);
    expect(result.groups[0]).toMatchObject({ duplicate_count: 3, size_bytes: 5000 });
  });
});

describe("drive_duplicates caps and empties", () => {
  it("caps the number of groups to limit_groups, keeping the largest", async () => {
    const ctx = writeIndex(fixtureFiles());
    const result = await run({ limit_groups: 1 }, ctx);
    expect(result.group_count).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ duplicate_count: 3, size_bytes: 5000 });
  });

  it("returns zeros for an empty index", async () => {
    const ctx = writeIndex([]);
    const result = await run({}, ctx);
    expect(result).toEqual({ group_count: 0, groups: [] });
  });

  it("returns zeros when no index file exists at all", async () => {
    // No index.json written; loadIndex falls back to the empty index.
    fs.mkdirSync(path.join(tmp, "empty-gvfs"), { recursive: true });
    const ctx = buildContext({ home: tmp, gvfsBase: path.join(tmp, "empty-gvfs") });
    const result = await run({}, ctx);
    expect(result).toEqual({ group_count: 0, groups: [] });
  });
});
