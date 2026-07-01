import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSendAs, updateSendAs } from "../tools/send-as.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    listSendAs: vi.fn(),
    updateSendAs: vi.fn(),
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "santo-sendas-tool-test-"));
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

describe("list_send_as tool", () => {
  it("slims each alias and counts them", async () => {
    const { context, client } = makeContext();
    client.listSendAs.mockResolvedValue([
      { sendAsEmail: "alice@x.com", isPrimary: true, isDefault: true },
      {
        sendAsEmail: "alias@x.com",
        signature: "<b>hi</b>",
        verificationStatus: "accepted",
        smtpMsa: { host: "drop" },
      },
    ]);
    const result = await listSendAs.handler({ account: "alice" }, context);
    expect(client.listSendAs).toHaveBeenCalledWith("alice");
    expect(result).toEqual({
      count: 2,
      send_as: [
        { send_as_email: "alice@x.com", is_primary: true, is_default: true },
        {
          send_as_email: "alias@x.com",
          signature: "<b>hi</b>",
          verification_status: "accepted",
        },
      ],
    });
  });
});

describe("update_send_as tool", () => {
  it("builds camelCase opts and slims the echo", async () => {
    const { context, client } = makeContext();
    client.updateSendAs.mockImplementation(async (_a, email, opts) => ({
      sendAsEmail: email,
      ...opts,
    }));
    const result = await updateSendAs.handler(
      {
        account: "alice",
        send_as_email: "alias@x.com",
        signature: "<b>new</b>",
        display_name: "Alias",
      },
      context,
    );
    expect(client.updateSendAs).toHaveBeenCalledWith("alice", "alias@x.com", {
      signature: "<b>new</b>",
      displayName: "Alias",
    });
    expect(result).toEqual({
      send_as_email: "alias@x.com",
      signature: "<b>new</b>",
      display_name: "Alias",
    });
  });

  it("sends only signature when display_name omitted", async () => {
    const { context, client } = makeContext();
    client.updateSendAs.mockImplementation(async (_a, email, opts) => ({
      sendAsEmail: email,
      ...opts,
    }));
    await updateSendAs.handler(
      { account: "alice", send_as_email: "alias@x.com", signature: "<b>s</b>" },
      context,
    );
    expect(client.updateSendAs).toHaveBeenCalledWith("alice", "alias@x.com", {
      signature: "<b>s</b>",
    });
  });
});
