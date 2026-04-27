import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCreds } from "../auth.js";
import { AuthError } from "../errors.js";

let tmpRoot: string;
let cfgPath: string;
let sharedEnvPath: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `smart-mcp-test-${Date.now()}-${Math.random()}`);
  mkdirSync(tmpRoot, { recursive: true });
  cfgPath = join(tmpRoot, "test-mcp.json");
  sharedEnvPath = join(tmpRoot, "smart-mcps.env");
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

describe(".env shared file resolution", () => {
  it("resolves a required key from shared .env when not in env", () => {
    writeFileSync(sharedEnvPath, "TEST_KEY=shared-env-value\n");
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("shared-env-value");
  });

  it("process.env overrides .env file", () => {
    process.env.TEST_KEY = "from-process-env";
    writeFileSync(sharedEnvPath, "TEST_KEY=from-shared-env\n");
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("from-process-env");
  });

  it("per-service JSON still works when .env doesn't have the key", () => {
    writeFileSync(sharedEnvPath, "OTHER_KEY=other\n");
    writeFileSync(cfgPath, JSON.stringify({ TEST_KEY: "from-json" }));
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("from-json");
  });

  it("throws AuthError when missing in process.env, .env, and JSON", () => {
    writeFileSync(sharedEnvPath, "OTHER=other\n");
    try {
      loadCreds<{ TEST_KEY: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        configPaths: [cfgPath],
        sharedEnvPath,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toContain("TEST_KEY");
    }
  });

  it("AuthError recovery message mentions the shared .env path", () => {
    try {
      loadCreds<{ TEST_KEY: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        configPaths: [cfgPath],
        sharedEnvPath,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).recovery).toContain(sharedEnvPath);
    }
  });

  it("missing .env file is silently OK", () => {
    process.env.TEST_KEY = "x";
    expect(() =>
      loadCreds<{ TEST_KEY: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        configPaths: [cfgPath],
        sharedEnvPath: join(tmpRoot, "does-not-exist.env"),
      }),
    ).not.toThrow();
  });

  it("malformed .env line is silently skipped", () => {
    writeFileSync(sharedEnvPath, "not a valid line\nTEST_KEY=value\n");
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("value");
  });

  it("comment lines and blank lines are ignored", () => {
    writeFileSync(sharedEnvPath, "# this is a comment\n\nTEST_KEY=value\n");
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("value");
  });

  it("double-quoted value with spaces is preserved", () => {
    writeFileSync(sharedEnvPath, 'TEST_KEY="some value with spaces"\n');
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("some value with spaces");
  });

  it("single-quoted value is literal (no escape interpretation)", () => {
    writeFileSync(sharedEnvPath, "TEST_KEY='no\\nescape'\n");
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("no\\nescape");
    expect(creds.TEST_KEY.length).toBe(10);
  });

  it("double-quoted escape sequences are interpreted", () => {
    writeFileSync(sharedEnvPath, 'TEST_KEY="line1\\nline2"\n');
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("line1\nline2");
  });

  it("trailing comments stripped on unquoted values", () => {
    writeFileSync(sharedEnvPath, "TEST_KEY=value # trailing comment\n");
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("value");
  });

  it("hash inside quoted value is preserved", () => {
    writeFileSync(sharedEnvPath, 'TEST_KEY="hash#stays"\n');
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("hash#stays");
  });

  it("empty value is treated as missing", () => {
    writeFileSync(sharedEnvPath, "TEST_KEY=\n");
    expect(() =>
      loadCreds<{ TEST_KEY: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        configPaths: [cfgPath],
        sharedEnvPath,
      }),
    ).toThrow(AuthError);
  });

  it("whitespace around = is trimmed on unquoted values", () => {
    writeFileSync(sharedEnvPath, "TEST_KEY = value\n");
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
      sharedEnvPath,
    });
    expect(creds.TEST_KEY).toBe("value");
  });
});
