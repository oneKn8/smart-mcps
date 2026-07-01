import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  getAutoForwarding,
  updateAutoForwarding,
  listForwardingAddresses,
  createForwardingAddress,
  deleteForwardingAddress,
} from "../tools/forwarding.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    getAutoForwarding: vi.fn(),
    updateAutoForwarding: vi.fn(),
    listForwardingAddresses: vi.fn(),
    createForwardingAddress: vi.fn(),
    deleteForwardingAddress: vi.fn(),
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "santo-forwarding-tool-test-"));
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

describe("get_auto_forwarding tool", () => {
  it("slims the raw autoForwarding resource", async () => {
    const { context, client } = makeContext();
    client.getAutoForwarding.mockResolvedValue({
      enabled: true,
      emailAddress: "dest@x.com",
      disposition: "archive",
      surprise: 1,
    });
    const result = await getAutoForwarding.handler({ account: "alice" }, context);
    expect(client.getAutoForwarding).toHaveBeenCalledWith("alice");
    expect(result).toEqual({
      enabled: true,
      email_address: "dest@x.com",
      disposition: "archive",
    });
  });
});

describe("update_auto_forwarding tool", () => {
  it("disabling (enabled=false) is ungated and calls the client", async () => {
    const { context, client } = makeContext();
    client.updateAutoForwarding.mockResolvedValue({ enabled: false });
    const result = await updateAutoForwarding.handler(
      { account: "alice", enabled: false },
      context,
    );
    expect(client.updateAutoForwarding).toHaveBeenCalledWith("alice", {
      enabled: false,
    });
    expect(result).toEqual({ enabled: false });
  });

  it("enabling without confirm throws ConfirmRequiredError naming the destination + OUTSIDE", async () => {
    const { context, client } = makeContext();
    try {
      await updateAutoForwarding.handler(
        { account: "alice", enabled: true, email_address: "dest@x.com" },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("dest@x.com");
      expect(preview).toContain("OUTSIDE this account");
    }
    expect(client.updateAutoForwarding).not.toHaveBeenCalled();
  });

  it("enabling with confirm=true calls the client with camelCase settings", async () => {
    const { context, client } = makeContext();
    client.updateAutoForwarding.mockResolvedValue({
      enabled: true,
      emailAddress: "dest@x.com",
    });
    await updateAutoForwarding.handler(
      {
        account: "alice",
        enabled: true,
        email_address: "dest@x.com",
        disposition: "markRead",
        confirm: true,
      },
      context,
    );
    expect(client.updateAutoForwarding).toHaveBeenCalledWith("alice", {
      enabled: true,
      emailAddress: "dest@x.com",
      disposition: "markRead",
    });
  });

  it("rejects enabling without email_address via zod refine", () => {
    expect(() =>
      (updateAutoForwarding.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", enabled: true }),
    ).toThrow();
  });

  it("rejects an smtp identity", async () => {
    writeIdentity("smtpy", "smtp");
    const { context, client } = makeContext();
    await expect(
      updateAutoForwarding.handler(
        { account: "smtpy", enabled: false },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.updateAutoForwarding).not.toHaveBeenCalled();
  });
});

describe("list_forwarding_addresses tool", () => {
  it("slims each address and counts them", async () => {
    const { context, client } = makeContext();
    client.listForwardingAddresses.mockResolvedValue([
      { forwardingEmail: "a@x.com", verificationStatus: "accepted", extra: 1 },
      { forwardingEmail: "b@x.com" },
    ]);
    const result = await listForwardingAddresses.handler(
      { account: "alice" },
      context,
    );
    expect(client.listForwardingAddresses).toHaveBeenCalledWith("alice");
    expect(result).toEqual({
      count: 2,
      forwarding_addresses: [
        { forwarding_email: "a@x.com", verification_status: "accepted" },
        { forwarding_email: "b@x.com" },
      ],
    });
  });
});

describe("create_forwarding_address tool", () => {
  it("gate: confirm=false throws ConfirmRequiredError naming destination + outside", async () => {
    const { context, client } = makeContext();
    try {
      await createForwardingAddress.handler(
        { account: "alice", forwarding_email: "dest@x.com" },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("dest@x.com");
      expect(preview).toContain("outside this account");
    }
    expect(client.createForwardingAddress).not.toHaveBeenCalled();
  });

  it("confirm=true calls the client and slims the result", async () => {
    const { context, client } = makeContext();
    client.createForwardingAddress.mockResolvedValue({
      forwardingEmail: "dest@x.com",
      verificationStatus: "pending",
    });
    const result = await createForwardingAddress.handler(
      { account: "alice", forwarding_email: "dest@x.com", confirm: true },
      context,
    );
    expect(client.createForwardingAddress).toHaveBeenCalledWith(
      "alice",
      "dest@x.com",
    );
    expect(result).toEqual({
      forwarding_email: "dest@x.com",
      verification_status: "pending",
    });
  });
});

describe("delete_forwarding_address tool", () => {
  it("gate: confirm=false throws ConfirmRequiredError", async () => {
    const { context, client } = makeContext();
    await expect(
      deleteForwardingAddress.handler(
        { account: "alice", forwarding_email: "dest@x.com" },
        context,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteForwardingAddress).not.toHaveBeenCalled();
  });

  it("confirm=true deletes and reports deleted", async () => {
    const { context, client } = makeContext();
    client.deleteForwardingAddress.mockResolvedValue(undefined);
    const result = await deleteForwardingAddress.handler(
      { account: "alice", forwarding_email: "dest@x.com", confirm: true },
      context,
    );
    expect(client.deleteForwardingAddress).toHaveBeenCalledWith(
      "alice",
      "dest@x.com",
    );
    expect(result).toEqual({
      forwarding_email: "dest@x.com",
      deleted: true,
    });
  });
});
