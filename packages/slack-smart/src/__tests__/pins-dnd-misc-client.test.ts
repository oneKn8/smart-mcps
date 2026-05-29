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

// ---------------------------------------------------------------------------
// listPins
// ---------------------------------------------------------------------------

describe("SlackClient.listPins", () => {
  it("sends GET to pins.list with user bearer token", async () => {
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/pins.list", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, items: [] });
      }),
    );
    const client = new SlackClient();
    await client.listPins({ channel: "C001" });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(seenUrl).toContain("channel=C001");
  });

  it("returns items array from response", async () => {
    const item = { type: "message", message: { ts: "111.0", text: "hi", user: "U001" } };
    server.use(
      http.get("https://slack.com/api/pins.list", () =>
        HttpResponse.json({ ok: true, items: [item] }),
      ),
    );
    const client = new SlackClient();
    const result = await client.listPins({ channel: "C001" });
    expect(result.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// addPin
// ---------------------------------------------------------------------------

describe("SlackClient.addPin", () => {
  it("sends POST to pins.add with user bearer token and correct body", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/pins.add", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    const result = await client.addPin({ channel: "C001", timestamp: "111.0" });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(seenBody?.channel).toBe("C001");
    expect(seenBody?.timestamp).toBe("111.0");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removePin
// ---------------------------------------------------------------------------

describe("SlackClient.removePin", () => {
  it("sends POST to pins.remove with user bearer token and correct body", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/pins.remove", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    const result = await client.removePin({ channel: "C001", timestamp: "111.0" });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(seenBody?.channel).toBe("C001");
    expect(seenBody?.timestamp).toBe("111.0");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dndInfo
// ---------------------------------------------------------------------------

describe("SlackClient.dndInfo", () => {
  it("sends GET to dnd.info with user bearer token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/dnd.info", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          dnd_enabled: false,
        });
      }),
    );
    const client = new SlackClient();
    await client.dndInfo({});
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("passes user arg as query param when provided", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/dnd.info", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, dnd_enabled: false });
      }),
    );
    const client = new SlackClient();
    await client.dndInfo({ user: "U999" });
    expect(seenUrl).toContain("user=U999");
  });

  it("returns dnd fields from response", async () => {
    server.use(
      http.get("https://slack.com/api/dnd.info", () =>
        HttpResponse.json({
          ok: true,
          dnd_enabled: true,
          next_dnd_start_ts: 1700000000,
          next_dnd_end_ts: 1700003600,
          snooze_enabled: true,
          snooze_endtime: 1700001800,
          snooze_remaining: 1800,
        }),
      ),
    );
    const client = new SlackClient();
    const result = await client.dndInfo({});
    expect(result.dnd_enabled).toBe(true);
    expect(result.next_dnd_start_ts).toBe(1700000000);
    expect(result.snooze_enabled).toBe(true);
    expect(result.snooze_endtime).toBe(1700001800);
  });
});

// ---------------------------------------------------------------------------
// setSnooze
// ---------------------------------------------------------------------------

describe("SlackClient.setSnooze", () => {
  it("sends POST to dnd.setSnooze with user bearer token and num_minutes in body", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/dnd.setSnooze", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          snooze_enabled: true,
          snooze_endtime: 1700001800,
          snooze_remaining: 1800,
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.setSnooze({ num_minutes: 30 });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(seenBody?.num_minutes).toBe(30);
    expect(result.snooze_enabled).toBe(true);
    expect(result.snooze_endtime).toBe(1700001800);
  });
});

// ---------------------------------------------------------------------------
// endSnooze
// ---------------------------------------------------------------------------

describe("SlackClient.endSnooze", () => {
  it("sends POST to dnd.endSnooze with user bearer token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.post("https://slack.com/api/dnd.endSnooze", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true, dnd_enabled: false });
      }),
    );
    const client = new SlackClient();
    const result = await client.endSnooze();
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(result.ok).toBe(true);
    expect(result.dnd_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listUsergroups
// ---------------------------------------------------------------------------

describe("SlackClient.listUsergroups", () => {
  it("sends GET to usergroups.list with user bearer token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/usergroups.list", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true, usergroups: [] });
      }),
    );
    const client = new SlackClient();
    await client.listUsergroups({});
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("passes include_disabled as query param when provided", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/usergroups.list", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, usergroups: [] });
      }),
    );
    const client = new SlackClient();
    await client.listUsergroups({ include_disabled: true });
    expect(seenUrl).toContain("include_disabled=true");
  });

  it("returns usergroups array from response", async () => {
    const ug = { id: "UG001", name: "dev", handle: "dev", user_count: 5 };
    server.use(
      http.get("https://slack.com/api/usergroups.list", () =>
        HttpResponse.json({ ok: true, usergroups: [ug] }),
      ),
    );
    const client = new SlackClient();
    const result = await client.listUsergroups({});
    expect(result.usergroups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// teamInfo
// ---------------------------------------------------------------------------

describe("SlackClient.teamInfo", () => {
  it("sends GET to team.info with user bearer token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/team.info", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          team: { id: "T001", name: "Acme", domain: "acme" },
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.teamInfo();
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect((result.team as Record<string, unknown>)["id"]).toBe("T001");
  });
});

// ---------------------------------------------------------------------------
// listEmoji
// ---------------------------------------------------------------------------

describe("SlackClient.listEmoji", () => {
  it("sends GET to emoji.list with user bearer token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/emoji.list", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          emoji: { rocket: "https://example.com/rocket.png" },
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.listEmoji();
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(result.emoji["rocket"]).toBe("https://example.com/rocket.png");
  });
});
