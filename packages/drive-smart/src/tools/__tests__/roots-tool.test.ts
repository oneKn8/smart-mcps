import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext } from "../../context.js";
import { driveRoots } from "../roots.js";

// drive_roots is a read-only discovery tool over a LOCAL-DISK config plus a
// bounded top-level probe of the gvfs mount base. These are integration tests:
// each drives the real handler against a unique temp home + an EMPTY temp gvfs
// base (never a real mount), then asserts the slim, field-stripped output.

const SLIM_ROOT_KEYS = [
  "account",
  "exists",
  "id",
  "kind",
  "label",
  "network",
  "path",
  "source",
];
const SLIM_ROOT_KEYS_NO_ACCOUNT = [
  "exists",
  "id",
  "kind",
  "label",
  "network",
  "path",
  "source",
];

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-smart-roots-"));
  tmpDirs.push(tmp);
  const home = path.join(tmp, "home");
  // EMPTY temp gvfs base: never a real mount. Tests that need a "network" root
  // create a fake `google-drive:...` directory under it via gvfsMount().
  const gvfsBase = path.join(tmp, "empty-gvfs");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(gvfsBase, { recursive: true });
  const stateDir = path.join(home, ".santo-agent", "drive-smart");

  return {
    tmp,
    home,
    gvfsBase,
    writeConfig(config: unknown) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify(config));
    },
    gvfsMount(name: string): string {
      const mount = path.join(gvfsBase, name);
      fs.mkdirSync(mount, { recursive: true });
      return mount;
    },
    localDir(name: string): string {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    async run() {
      const ctx = buildContext({ home, gvfsBase });
      return driveRoots.handler(driveRoots.inputSchema.parse({}), ctx);
    },
  };
}

describe("drive_roots metadata", () => {
  it("exposes the exact snake_case name and a non-empty description", () => {
    expect(driveRoots.name).toBe("drive_roots");
    expect(driveRoots.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(typeof driveRoots.description).toBe("string");
    expect(driveRoots.description.length).toBeGreaterThan(0);
  });
});

describe("drive_roots schema", () => {
  it("resolves an empty object to the documented default of {}", () => {
    expect(driveRoots.inputSchema.parse({})).toEqual({});
  });

  it("rejects clearly-invalid (non-object) input", () => {
    expect(() => driveRoots.inputSchema.parse(42)).toThrow();
    expect(() => driveRoots.inputSchema.parse("nope")).toThrow();
    expect(() => driveRoots.inputSchema.parse(null)).toThrow();
  });
});

describe("drive_roots output shape", () => {
  it("returns only a roots key holding an array", async () => {
    const env = setup();
    const result = await env.run();
    expect(Object.keys(result).sort()).toEqual(["roots"]);
    expect(Array.isArray(result.roots)).toBe(true);
  });

  it("emits SlimRoot with exactly the slim keys and omits account when absent", async () => {
    const env = setup();
    const local = env.localDir("local");
    env.writeConfig({
      roots: [{ id: "local-root", label: "Local", path: local, kind: "local" }],
    });

    const result = await env.run();

    expect(result.roots).toHaveLength(1);
    const root = result.roots[0]!;
    expect(Object.keys(root).sort()).toEqual([...SLIM_ROOT_KEYS_NO_ACCOUNT].sort());
    // Upstream DriveRoot bookkeeping never leaks and account is dropped.
    expect(root).not.toHaveProperty("account");
  });

  it("includes the account key with its value when the root has one", async () => {
    const env = setup();
    const local = env.localDir("local");
    env.writeConfig({
      roots: [
        {
          id: "acc-root",
          label: "Acc",
          path: local,
          account: "user@example.com",
          kind: "local",
        },
      ],
    });

    const result = await env.run();

    const root = result.roots[0]!;
    expect(Object.keys(root).sort()).toEqual([...SLIM_ROOT_KEYS].sort());
    expect(root.account).toBe("user@example.com");
  });
});

describe("drive_roots discovery", () => {
  it("maps a config local root to exact slim values with network false", async () => {
    const env = setup();
    const local = env.localDir("workspace");
    env.writeConfig({
      roots: [{ id: "local-root", label: "Workspace", path: local, kind: "local" }],
    });

    const result = await env.run();

    expect(result.roots).toEqual([
      {
        id: "local-root",
        label: "Workspace",
        path: local,
        kind: "local",
        source: "config",
        exists: true,
        network: false,
      },
    ]);
  });

  it("derives a network root from a gvfs mount name, parsing the account", async () => {
    const env = setup();
    const mount = env.gvfsMount("google-drive:host=gmail.com,user=alpha");

    const result = await env.run();

    expect(result.roots).toHaveLength(1);
    const root = result.roots[0]!;
    expect(root).toEqual({
      id: "alpha-gmail-com",
      label: "alpha@gmail.com",
      path: mount,
      account: "alpha@gmail.com",
      kind: "google-drive",
      source: "auto",
      exists: true,
      network: true,
    });
  });

  it("probes only the top level of the gvfs base and does not descend into a mount", async () => {
    const env = setup();
    const mount = env.gvfsMount("google-drive:host=gmail.com,user=beta");
    // Nested content that a descending walk would surface as extra roots.
    fs.mkdirSync(path.join(mount, "google-drive:host=evil,user=x"), { recursive: true });
    fs.writeFileSync(path.join(mount, "inside.txt"), "should not be read");

    const result = await env.run();

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]!.path).toBe(mount);
  });

  it("ignores non-google-drive mounts under the gvfs base", async () => {
    const env = setup();
    env.gvfsMount("smb-share:server=nas,share=data");
    env.gvfsMount("google-drive:host=gmail.com,user=gamma");

    const result = await env.run();

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]!.kind).toBe("google-drive");
    expect(result.roots[0]!.account).toBe("gamma@gmail.com");
  });

  it("returns an empty roots array when nothing is configured or mounted", async () => {
    const env = setup();
    const result = await env.run();
    expect(result.roots).toEqual([]);
  });

  it("combines config and network roots with correct per-root network flags", async () => {
    const env = setup();
    const local = env.localDir("disk");
    env.writeConfig({
      roots: [{ id: "local-root", label: "Disk", path: local, kind: "local" }],
    });
    env.gvfsMount("google-drive:host=gmail.com,user=delta");

    const result = await env.run();

    expect(result.roots).toHaveLength(2);
    const localRoot = result.roots.find(r => r.id === "local-root")!;
    const netRoot = result.roots.find(r => r.id === "delta-gmail-com")!;
    expect(localRoot.network).toBe(false);
    expect(localRoot.source).toBe("config");
    expect(netRoot.network).toBe(true);
    expect(netRoot.source).toBe("auto");
  });

  it("marks a config root at a missing path as not existing with default kind and label", async () => {
    const env = setup();
    const missing = path.join(env.tmp, "no", "such", "drive-smart-xyz");
    env.writeConfig({ roots: [{ path: missing }] });

    const result = await env.run();

    expect(result.roots).toHaveLength(1);
    const root = result.roots[0]!;
    expect(root.exists).toBe(false);
    expect(root.network).toBe(false);
    expect(root.kind).toBe("unknown");
    expect(root.label).toBe("drive-smart-xyz");
    expect(typeof root.id).toBe("string");
    expect(root.id.length).toBeGreaterThan(0);
  });
});
