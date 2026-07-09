import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverRoots, isGvfsPath } from "../roots.js";

let tmp: string;
let home: string;
let gvfsBase: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-smart-roots-"));
  home = path.join(tmp, "home");
  gvfsBase = path.join(tmp, "gvfs");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(gvfsBase, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("discoverRoots", () => {
  it("uses configured roots first and derives defaults for missing fields", () => {
    const work = path.join(tmp, "work");
    fs.mkdirSync(work);

    const roots = discoverRoots(
      {
        roots: [
          {
            path: work,
            label: "Work Drive",
            account: "alice@example.com",
            kind: "google-drive",
          },
          { id: "missing-root", path: path.join(tmp, "missing") },
        ],
      },
      { gvfsBase, home },
    );

    expect(roots[0]).toMatchObject({
      label: "Work Drive",
      path: work,
      account: "alice@example.com",
      kind: "google-drive",
      source: "config",
      exists: true,
    });
    // id is slug-derived from the path when omitted.
    expect(roots[0]?.id).toMatch(/^[a-z0-9-]+$/);
    expect(Object.keys(roots[0] ?? {}).sort()).toEqual([
      "account",
      "exists",
      "id",
      "kind",
      "label",
      "path",
      "source",
    ]);
    expect(roots[1]).toMatchObject({
      id: "missing-root",
      label: "missing",
      path: path.join(tmp, "missing"),
      kind: "unknown",
      source: "config",
      exists: false,
    });
  });

  it("discovers a common local Drive folder under the injected home", () => {
    const drive = path.join(home, "Google Drive");
    fs.mkdirSync(drive);

    const roots = discoverRoots({}, { gvfsBase, home });

    expect(roots).toContainEqual(
      expect.objectContaining({
        label: "Google Drive",
        path: drive,
        kind: "local",
        source: "auto",
        exists: true,
      }),
    );
  });

  it("registers each gvfs google-drive mount as a single network root without descending", () => {
    // The mount name encodes the account; we must NOT need to read inside the
    // mount to learn it. The mount dir is created empty on purpose — a correct
    // implementation never reads its contents (a real one would hang).
    const mountName = "google-drive:host=gmail.com,user=alice";
    const mountPath = path.join(gvfsBase, mountName);
    fs.mkdirSync(mountPath);
    // A non-google mount and a would-be child that must be ignored.
    fs.mkdirSync(path.join(gvfsBase, "sftp:host=example.com"));

    const roots = discoverRoots({}, { gvfsBase, home });

    const gvfsRoots = roots.filter(root => root.source === "auto" && root.kind === "google-drive");
    expect(gvfsRoots).toHaveLength(1);
    expect(gvfsRoots[0]).toEqual({
      id: "alice-gmail-com",
      label: "alice@gmail.com",
      path: mountPath,
      account: "alice@gmail.com",
      kind: "google-drive",
      source: "auto",
      exists: true,
    });
    // No child roots (e.g. "My Drive") are produced: discovery does not descend.
    expect(roots.every(root => path.dirname(root.path) !== mountPath)).toBe(true);
  });

  it("does not stat a configured gvfs path (would hang) and marks it existing", () => {
    const mountName = "google-drive:host=gmail.com,user=bob";
    const configuredGvfs = path.join(gvfsBase, mountName, "0ABCdeadbeef");
    // The path is never created; existsSync would be false, but a gvfs path is
    // assumed present without statting it.
    const roots = discoverRoots(
      { roots: [{ id: "bob-drive", path: configuredGvfs, account: "bob@gmail.com", kind: "google-drive" }] },
      { gvfsBase, home },
    );

    expect(roots[0]).toMatchObject({ id: "bob-drive", path: configuredGvfs, exists: true });
  });

  it("skips gvfs discovery entirely when no gvfsBase is injected", () => {
    fs.mkdirSync(path.join(gvfsBase, "google-drive:host=gmail.com,user=alice"));

    const roots = discoverRoots({}, { home });

    expect(roots.some(root => root.kind === "google-drive")).toBe(false);
  });
});

describe("isGvfsPath", () => {
  it("matches paths under the gvfs base and the base itself", () => {
    expect(isGvfsPath("/run/user/1000/gvfs", "/run/user/1000/gvfs")).toBe(true);
    expect(isGvfsPath("/run/user/1000/gvfs/google-drive:x/My Drive", "/run/user/1000/gvfs")).toBe(true);
  });

  it("does not match unrelated paths or when no base is given", () => {
    expect(isGvfsPath("/home/alice/Drive", "/run/user/1000/gvfs")).toBe(false);
    expect(isGvfsPath("/run/user/1000/gvfs/x", undefined)).toBe(false);
  });
});
