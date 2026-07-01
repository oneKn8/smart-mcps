import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getVacation, updateVacation } from "../tools/vacation.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    getVacation: vi.fn(),
    updateVacation: vi.fn(),
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "santo-vacation-tool-test-"));
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

describe("get_vacation tool", () => {
  it("slims the raw vacation resource", async () => {
    const { context, client } = makeContext();
    client.getVacation.mockResolvedValue({
      enableAutoReply: true,
      responseSubject: "Away",
      extra: "drop",
    });
    const result = await getVacation.handler({ account: "alice" }, context);
    expect(client.getVacation).toHaveBeenCalledWith("alice");
    expect(result).toEqual({
      enable_auto_reply: true,
      response_subject: "Away",
    });
  });
});

describe("update_vacation tool", () => {
  it("builds camelCase settings and slims the echo", async () => {
    const { context, client } = makeContext();
    client.updateVacation.mockImplementation(async (_a, s) => s);
    const result = await updateVacation.handler(
      {
        account: "alice",
        enable_auto_reply: true,
        response_subject: "Away",
        response_body_plain_text: "back monday",
        start_time: "1719792000000",
        end_time: "1720396800000",
      },
      context,
    );
    expect(client.updateVacation).toHaveBeenCalledWith("alice", {
      enableAutoReply: true,
      responseSubject: "Away",
      responseBodyPlainText: "back monday",
      startTime: "1719792000000",
      endTime: "1720396800000",
    });
    expect(result).toEqual({
      enable_auto_reply: true,
      response_subject: "Away",
      response_body_plain_text: "back monday",
      start_time: "1719792000000",
      end_time: "1720396800000",
    });
  });

  it("disables auto-reply with just enable_auto_reply: false", async () => {
    const { context, client } = makeContext();
    client.updateVacation.mockImplementation(async (_a, s) => s);
    await updateVacation.handler(
      { account: "alice", enable_auto_reply: false },
      context,
    );
    expect(client.updateVacation).toHaveBeenCalledWith("alice", {
      enableAutoReply: false,
    });
  });
});
