import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { SlackClient } from "../client.js";

// Locks the exact Slack method + HTTP verb + token for every client method added
// in the 2026-07-05 scope expansion. A wrong method name or verb here would only
// surface at runtime (after a token reinstall), so it is pinned by tests.

const USER_TOKEN = "xoxp-test-user-token";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedUserToken: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedUserToken = process.env.SLACK_USER_TOKEN;
  savedHome = process.env.HOME;
  process.env.SLACK_USER_TOKEN = USER_TOKEN;
  process.env.HOME = "/tmp/slack-smart-test-no-home";
});

afterEach(() => {
  if (savedUserToken === undefined) delete process.env.SLACK_USER_TOKEN;
  else process.env.SLACK_USER_TOKEN = savedUserToken;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe("conversations lifecycle client methods", () => {
  it("joinChannel POSTs conversations.join with the user token", async () => {
    let auth: string | null = null;
    server.use(
      http.post("https://slack.com/api/conversations.join", ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true, channel: { id: "C001" } });
      }),
    );
    const client = new SlackClient();
    const r = await client.joinChannel({ channel: "C001" });
    expect(auth).toBe(`Bearer ${USER_TOKEN}`);
    expect((r.channel as { id: string }).id).toBe("C001");
  });

  it("leaveChannel POSTs conversations.leave", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/conversations.leave", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    await client.leaveChannel({ channel: "C002" });
    expect(body?.["channel"]).toBe("C002");
  });

  it("archiveChannel POSTs conversations.archive", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/conversations.archive", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    await client.archiveChannel({ channel: "C003" });
    expect(body?.["channel"]).toBe("C003");
  });
});

describe("files.delete client method", () => {
  it("deleteFile POSTs files.delete", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/files.delete", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    await client.deleteFile({ file: "F1" });
    expect(body?.["file"]).toBe("F1");
  });
});

describe("scheduled message client methods", () => {
  it("listScheduledMessages GETs chat.scheduledMessages.list", async () => {
    let auth: string | null = null;
    server.use(
      http.get(
        "https://slack.com/api/chat.scheduledMessages.list",
        ({ request }) => {
          auth = request.headers.get("authorization");
          return HttpResponse.json({ ok: true, scheduled_messages: [{ id: "Q1" }] });
        },
      ),
    );
    const client = new SlackClient();
    const r = await client.listScheduledMessages({ channel: "C001" });
    expect(auth).toBe(`Bearer ${USER_TOKEN}`);
    expect(r.scheduled_messages).toHaveLength(1);
  });

  it("deleteScheduledMessage POSTs chat.deleteScheduledMessage", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post(
        "https://slack.com/api/chat.deleteScheduledMessage",
        async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ ok: true });
        },
      ),
    );
    const client = new SlackClient();
    await client.deleteScheduledMessage({
      channel: "C001",
      scheduled_message_id: "Q1",
    });
    expect(body?.["channel"]).toBe("C001");
    expect(body?.["scheduled_message_id"]).toBe("Q1");
  });
});

describe("status/presence client methods", () => {
  it("setProfile POSTs users.profile.set with a profile object", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/users.profile.set", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, profile: {} });
      }),
    );
    const client = new SlackClient();
    await client.setProfile({ profile: { status_text: "brb" } });
    expect((body?.["profile"] as Record<string, unknown>)["status_text"]).toBe("brb");
  });

  it("setPresence POSTs users.setPresence", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/users.setPresence", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    await client.setPresence({ presence: "away" });
    expect(body?.["presence"]).toBe("away");
  });
});

describe("bookmarks client methods", () => {
  it("listBookmarks GETs bookmarks.list", async () => {
    let url: string | null = null;
    server.use(
      http.get("https://slack.com/api/bookmarks.list", ({ request }) => {
        url = request.url;
        return HttpResponse.json({ ok: true, bookmarks: [] });
      }),
    );
    const client = new SlackClient();
    await client.listBookmarks({ channel_id: "C001" });
    expect(url).toContain("channel_id=C001");
  });

  it("addBookmark POSTs bookmarks.add", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/bookmarks.add", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, bookmark: { id: "Bk1" } });
      }),
    );
    const client = new SlackClient();
    await client.addBookmark({
      channel_id: "C001",
      title: "Docs",
      type: "link",
      link: "https://x.com",
    });
    expect(body?.["channel_id"]).toBe("C001");
    expect(body?.["title"]).toBe("Docs");
    expect(body?.["type"]).toBe("link");
  });

  it("editBookmark POSTs bookmarks.edit", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/bookmarks.edit", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, bookmark: { id: "Bk1" } });
      }),
    );
    const client = new SlackClient();
    await client.editBookmark({
      channel_id: "C001",
      bookmark_id: "Bk1",
      title: "New",
    });
    expect(body?.["bookmark_id"]).toBe("Bk1");
    expect(body?.["title"]).toBe("New");
  });

  it("removeBookmark POSTs bookmarks.remove", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/bookmarks.remove", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    await client.removeBookmark({ channel_id: "C001", bookmark_id: "Bk1" });
    expect(body?.["channel_id"]).toBe("C001");
    expect(body?.["bookmark_id"]).toBe("Bk1");
  });
});
