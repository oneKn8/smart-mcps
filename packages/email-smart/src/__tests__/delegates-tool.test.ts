import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  listDelegates,
  createDelegate,
  deleteDelegate,
} from "../tools/delegates.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    listDelegates: vi.fn(),
    createDelegate: vi.fn(),
    deleteDelegate: vi.fn(),
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "santo-delegates-tool-test-"));
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

describe("list_delegates tool", () => {
  it("slims each delegate and counts them", async () => {
    const { context, client } = makeContext();
    client.listDelegates.mockResolvedValue([
      { delegateEmail: "a@x.com", verificationStatus: "accepted", extra: 1 },
      { delegateEmail: "b@x.com" },
    ]);
    const result = await listDelegates.handler({ account: "alice" }, context);
    expect(client.listDelegates).toHaveBeenCalledWith("alice");
    expect(result).toEqual({
      count: 2,
      delegates: [
        { delegate_email: "a@x.com", verification_status: "accepted" },
        { delegate_email: "b@x.com" },
      ],
    });
  });
});

describe("create_delegate tool", () => {
  it("gate: confirm=false throws ConfirmRequiredError with FULL access warning", async () => {
    const { context, client } = makeContext();
    try {
      await createDelegate.handler(
        { account: "alice", delegate_email: "assistant@x.com" },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("assistant@x.com");
      expect(preview).toContain("FULL read/send access to your mailbox");
    }
    expect(client.createDelegate).not.toHaveBeenCalled();
  });

  it("confirm=true calls the client and slims the result", async () => {
    const { context, client } = makeContext();
    client.createDelegate.mockResolvedValue({
      delegateEmail: "assistant@x.com",
      verificationStatus: "accepted",
    });
    const result = await createDelegate.handler(
      { account: "alice", delegate_email: "assistant@x.com", confirm: true },
      context,
    );
    expect(client.createDelegate).toHaveBeenCalledWith(
      "alice",
      "assistant@x.com",
    );
    expect(result).toEqual({
      delegate_email: "assistant@x.com",
      verification_status: "accepted",
    });
  });

  it("rejects an smtp identity", async () => {
    writeIdentity("smtpy", "smtp");
    const { context, client } = makeContext();
    await expect(
      createDelegate.handler(
        { account: "smtpy", delegate_email: "a@x.com", confirm: true },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.createDelegate).not.toHaveBeenCalled();
  });
});

describe("delete_delegate tool", () => {
  it("gate: confirm=false throws ConfirmRequiredError", async () => {
    const { context, client } = makeContext();
    await expect(
      deleteDelegate.handler(
        { account: "alice", delegate_email: "assistant@x.com" },
        context,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteDelegate).not.toHaveBeenCalled();
  });

  it("confirm=true deletes and reports deleted", async () => {
    const { context, client } = makeContext();
    client.deleteDelegate.mockResolvedValue(undefined);
    const result = await deleteDelegate.handler(
      { account: "alice", delegate_email: "assistant@x.com", confirm: true },
      context,
    );
    expect(client.deleteDelegate).toHaveBeenCalledWith(
      "alice",
      "assistant@x.com",
    );
    expect(result).toEqual({
      delegate_email: "assistant@x.com",
      deleted: true,
    });
  });
});
