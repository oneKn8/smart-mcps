import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NotFoundError, ValidationError } from "smart-mcp-core";
import { loadIdentity, listIdentities } from "../identities.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-test-home-"));
}

function writeIdentity(home: string, fileBase: string, body: string): string {
  const dir = path.join(home, ".santo-agent", "identities");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${fileBase}.yaml`);
  fs.writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
  vi.restoreAllMocks();
});

describe("loadIdentity", () => {
  it("reads + parses YAML, defaulting transport to 'oauth' when missing", () => {
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice Example",
      ].join("\n"),
    );
    const id = loadIdentity("alice", tmpHome);
    expect(id.account).toBe("alice");
    expect(id.email).toBe("alice@example.com");
    expect(id.display_name).toBe("Alice Example");
    expect(id.transport).toBe("oauth");
  });

  it("preserves explicit transport: smtp", () => {
    writeIdentity(
      tmpHome,
      "bob",
      [
        "account: bob",
        "email: bob@test",
        "display_name: Bob",
        "transport: smtp",
      ].join("\n"),
    );
    const id = loadIdentity("bob", tmpHome);
    expect(id.transport).toBe("smtp");
  });

  it("throws ValidationError when transport is not oauth or smtp", () => {
    writeIdentity(
      tmpHome,
      "bob",
      [
        "account: bob",
        "email: bob@test",
        "display_name: Bob",
        "transport: pigeon",
      ].join("\n"),
    );
    expect(() => loadIdentity("bob", tmpHome)).toThrow(ValidationError);
  });

  it("throws NotFoundError with exact message when file missing (HOME overridden)", () => {
    const ghostHome = path.join(
      os.tmpdir(),
      `santo-test-NONEXISTENT-${Date.now()}-${Math.random()}`,
    );
    process.env.HOME = ghostHome;
    try {
      loadIdentity("ghost", ghostHome);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe("identity not found: ghost");
    }
  });

  it("throws ValidationError when email field missing", () => {
    writeIdentity(
      tmpHome,
      "alice",
      ["account: alice", "display_name: Alice Example"].join("\n"),
    );
    expect(() => loadIdentity("alice", tmpHome)).toThrow(ValidationError);
  });

  it("throws ValidationError when display_name field missing", () => {
    writeIdentity(
      tmpHome,
      "alice",
      ["account: alice", "email: alice@example.com"].join("\n"),
    );
    expect(() => loadIdentity("alice", tmpHome)).toThrow(ValidationError);
  });

  it("throws ValidationError when file's account field disagrees with requested account", () => {
    writeIdentity(
      tmpHome,
      "bob",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice Example",
      ].join("\n"),
    );
    expect(() => loadIdentity("bob", tmpHome)).toThrow(ValidationError);
  });

  it("populates optional fields when present", () => {
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice Example",
        "default_footer: Footer here",
        "default_reply_to: reply@example.com",
        "signature_html: <strong>Alice</strong>",
        "signature_text: Alice",
      ].join("\n"),
    );
    const id = loadIdentity("alice", tmpHome);
    expect(id.default_footer).toBe("Footer here");
    expect(id.default_reply_to).toBe("reply@example.com");
    expect(id.signature_html).toBe("<strong>Alice</strong>");
    expect(id.signature_text).toBe("Alice");
  });
});

describe("listIdentities", () => {
  it("returns all *.yaml in dir, sorted by account ascending", () => {
    writeIdentity(
      tmpHome,
      "charlie",
      [
        "account: charlie",
        "email: charlie@example.com",
        "display_name: Charlie",
      ].join("\n"),
    );
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice",
      ].join("\n"),
    );
    writeIdentity(
      tmpHome,
      "bob",
      ["account: bob", "email: bob@test", "display_name: Bob"].join("\n"),
    );
    const ids = listIdentities(tmpHome);
    expect(ids.map((i) => i.account)).toEqual(["alice", "bob", "charlie"]);
  });

  it("returns [] when identities directory is missing", () => {
    expect(listIdentities(tmpHome)).toEqual([]);
  });

  it("skips files that fail YAML parse, logs to stderr, does not crash", () => {
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice",
      ].join("\n"),
    );
    writeIdentity(tmpHome, "broken", ":\n  - this: is: not: yaml\n   bad indent");
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const ids = listIdentities(tmpHome);
    expect(ids.map((i) => i.account)).toEqual(["alice"]);
    expect(errSpy).toHaveBeenCalled();
    const messages = errSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("broken"))).toBe(true);
  });

  it("skips files that fail required-field validation, logs, returns the rest", () => {
    writeIdentity(
      tmpHome,
      "alice",
      [
        "account: alice",
        "email: alice@example.com",
        "display_name: Alice",
      ].join("\n"),
    );
    // Missing display_name → should be skipped.
    writeIdentity(
      tmpHome,
      "no-name",
      ["account: no-name", "email: noname@test"].join("\n"),
    );
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const ids = listIdentities(tmpHome);
    expect(ids.map((i) => i.account)).toEqual(["alice"]);
    expect(errSpy).toHaveBeenCalled();
  });
});
