import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getImap,
  updateImap,
  getPop,
  updatePop,
  updateLanguage,
} from "../tools/mail-client-settings.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    getImap: vi.fn(),
    updateImap: vi.fn(),
    getPop: vi.fn(),
    updatePop: vi.fn(),
    updateLanguage: vi.fn(),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return {
    context: { client: client as unknown as EmailClient, home: tmpHome },
    client,
  };
}

let savedHome: string | undefined;
let tmpHome: string;

function writeIdentity(account: string, transport = "oauth"): void {
  const dir = path.join(tmpHome, ".santo-agent", "identities");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${account}.yaml`),
    [
      `account: ${account}`,
      `email: ${account}@example.com`,
      `display_name: ${account}`,
      `transport: ${transport}`,
    ].join("\n"),
  );
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "santo-mcs-tool-test-"));
  process.env.HOME = tmpHome;
  delete process.env.EMAIL_DEFAULT_ACCOUNT;
  writeIdentity("alice");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("get_imap / update_imap", () => {
  it("get_imap slims the raw resource", async () => {
    const { context, client } = makeContext();
    client.getImap.mockResolvedValue({
      enabled: true,
      autoExpunge: false,
      expungeBehavior: "archive",
      maxFolderSize: 5000,
    });
    const result = await getImap.handler({ account: "alice" }, context);
    expect(result).toEqual({
      enabled: true,
      auto_expunge: false,
      expunge_behavior: "archive",
      max_folder_size: 5000,
    });
  });

  it("update_imap builds camelCase settings", async () => {
    const { context, client } = makeContext();
    client.updateImap.mockImplementation(async (_a, s) => s);
    await updateImap.handler(
      { account: "alice", enabled: true, expunge_behavior: "deleteForever" },
      context,
    );
    expect(client.updateImap).toHaveBeenCalledWith("alice", {
      enabled: true,
      expungeBehavior: "deleteForever",
    });
  });
});

describe("get_pop / update_pop", () => {
  it("get_pop slims the raw resource", async () => {
    const { context, client } = makeContext();
    client.getPop.mockResolvedValue({
      accessWindow: "allMail",
      disposition: "leaveInInbox",
    });
    const result = await getPop.handler({ account: "alice" }, context);
    expect(result).toEqual({
      access_window: "allMail",
      disposition: "leaveInInbox",
    });
  });

  it("update_pop builds camelCase settings", async () => {
    const { context, client } = makeContext();
    client.updatePop.mockImplementation(async (_a, s) => s);
    await updatePop.handler(
      { account: "alice", access_window: "disabled" },
      context,
    );
    expect(client.updatePop).toHaveBeenCalledWith("alice", {
      accessWindow: "disabled",
    });
  });
});

describe("update_language", () => {
  it("passes the display language and slims the echo", async () => {
    const { context, client } = makeContext();
    client.updateLanguage.mockResolvedValue({ displayLanguage: "en-GB" });
    const result = await updateLanguage.handler(
      { account: "alice", display_language: "en-GB" },
      context,
    );
    expect(client.updateLanguage).toHaveBeenCalledWith("alice", "en-GB");
    expect(result).toEqual({ display_language: "en-GB" });
  });
});
