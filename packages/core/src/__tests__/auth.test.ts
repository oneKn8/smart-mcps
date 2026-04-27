import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCreds } from "../auth.js";
import { AuthError } from "../errors.js";

let tmpRoot: string;
let cfgPath: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `smart-mcp-test-${Date.now()}-${Math.random()}`);
  mkdirSync(tmpRoot, { recursive: true });
  cfgPath = join(tmpRoot, "test-mcp.json");
  delete process.env.TEST_KEY;
  delete process.env.TEST_OPTIONAL;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadCreds", () => {
  it("loads from env when env present", () => {
    process.env.TEST_KEY = "env-value";
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
    });
    expect(creds.TEST_KEY).toBe("env-value");
  });

  it("falls back to config file when env missing", () => {
    writeFileSync(cfgPath, JSON.stringify({ TEST_KEY: "file-value" }));
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
    });
    expect(creds.TEST_KEY).toBe("file-value");
  });

  it("env wins over config file", () => {
    process.env.TEST_KEY = "from-env";
    writeFileSync(cfgPath, JSON.stringify({ TEST_KEY: "from-file" }));
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
    });
    expect(creds.TEST_KEY).toBe("from-env");
  });

  it("throws AuthError listing missing required keys", () => {
    try {
      loadCreds<{ TEST_KEY: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        configPaths: [cfgPath],
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toContain("TEST_KEY");
      expect((err as AuthError).message).toContain("test-mcp");
    }
  });

  it("returns optional keys when present, omits when missing", () => {
    process.env.TEST_KEY = "x";
    process.env.TEST_OPTIONAL = "opt";
    const creds = loadCreds<{ TEST_KEY: string; TEST_OPTIONAL?: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      optional: ["TEST_OPTIONAL"],
      configPaths: [cfgPath],
    });
    expect(creds.TEST_OPTIONAL).toBe("opt");
  });

  it("missing optional keys do not throw", () => {
    process.env.TEST_KEY = "x";
    expect(() =>
      loadCreds<{ TEST_KEY: string; TEST_OPTIONAL?: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        optional: ["TEST_OPTIONAL"],
        configPaths: [cfgPath],
      }),
    ).not.toThrow();
  });

  it("ignores nonexistent config paths gracefully", () => {
    process.env.TEST_KEY = "x";
    expect(() =>
      loadCreds<{ TEST_KEY: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        configPaths: ["/nonexistent/path.json", cfgPath],
      }),
    ).not.toThrow();
  });
});
