import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthError, NotFoundError } from "smart-mcp-core";
import { DocsClient } from "../client.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DOCS_API_BASE = "https://docs.googleapis.com/v1";
const DOC_URL = (id: string): string => `${DOCS_API_BASE}/documents/${id}`;
const CREATE_URL = `${DOCS_API_BASE}/documents`;
const BATCH_URL = (id: string): string =>
  `${DOCS_API_BASE}/documents/${id}:batchUpdate`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "docs-client-test-"));
}

function writeDocsTokenFile(
  home: string,
  account: string,
  payload: unknown,
): string {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${account}.docs.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function fixtureFile(opts: { expiry: string; token?: string }) {
  return {
    token: opts.token ?? "test-access-token",
    refresh_token: "test-refresh-token",
    token_uri: TOKEN_URL,
    client_id: "test-client.apps.googleusercontent.com",
    client_secret: "test-secret",
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
    ],
    expiry: opts.expiry,
  };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-30T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const FRESH_TOKEN = (): void => {
  writeDocsTokenFile(
    tmpHome,
    "alice",
    fixtureFile({ expiry: "2026-06-30T13:00:00.000Z" }),
  );
};

describe("DocsClient — constructor", () => {
  it("is side-effect-free without HOME", () => {
    delete process.env.HOME;
    expect(() => new DocsClient("alice")).not.toThrow();
  });

  it("getAccount returns the constructor account", () => {
    expect(new DocsClient("alice").getAccount()).toBe("alice");
  });

  it("throws AuthError when the token file is missing", async () => {
    // HOME points at a fresh tmp dir with no token jar.
    const client = new DocsClient("nobody");
    await expect(
      client.getDocument({ documentId: "doc_x" }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("DocsClient.getDocument", () => {
  it("GETs the document and returns the raw resource", async () => {
    FRESH_TOKEN();
    server.use(
      http.get(DOC_URL("doc_abc"), () =>
        HttpResponse.json({
          documentId: "doc_abc",
          title: "Plan",
          revisionId: "rev_1",
          body: { content: [] },
        }),
      ),
    );
    const out = await new DocsClient("alice").getDocument({
      documentId: "doc_abc",
    });
    expect(out.documentId).toBe("doc_abc");
    expect(out.title).toBe("Plan");
  });

  it("passes includeTabsContent as a query param", async () => {
    FRESH_TOKEN();
    let seen: string | null = null;
    server.use(
      http.get(DOC_URL("doc_abc"), ({ request }) => {
        seen = new URL(request.url).searchParams.get("includeTabsContent");
        return HttpResponse.json({ documentId: "doc_abc" });
      }),
    );
    await new DocsClient("alice").getDocument({
      documentId: "doc_abc",
      includeTabsContent: true,
    });
    expect(seen).toBe("true");
  });

  it("rewrites a 404 into a NotFoundError naming the doc id", async () => {
    FRESH_TOKEN();
    server.use(
      http.get(DOC_URL("missing"), () =>
        HttpResponse.json({ error: { code: 404 } }, { status: 404 }),
      ),
    );
    await expect(
      new DocsClient("alice").getDocument({ documentId: "missing" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("DocsClient.createDocument", () => {
  it("POSTs ONLY the title (create is title-only)", async () => {
    FRESH_TOKEN();
    let body: unknown;
    server.use(
      http.post(CREATE_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ documentId: "doc_new", title: "Fresh" });
      }),
    );
    const out = await new DocsClient("alice").createDocument({ title: "Fresh" });
    expect(body).toEqual({ title: "Fresh" });
    expect(out.documentId).toBe("doc_new");
  });
});

describe("DocsClient.batchUpdate", () => {
  it("forwards the requests array verbatim and returns replies", async () => {
    FRESH_TOKEN();
    let body: unknown;
    server.use(
      http.post(BATCH_URL("doc_abc"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          documentId: "doc_abc",
          replies: [{ replaceAllText: { occurrencesChanged: 3 } }],
        });
      }),
    );
    const requests = [
      { insertText: { text: "Hi", location: { index: 1 } } },
    ];
    const res = await new DocsClient("alice").batchUpdate({
      documentId: "doc_abc",
      requests,
    });
    expect(body).toEqual({ requests });
    expect(res.replies).toEqual([{ replaceAllText: { occurrencesChanged: 3 } }]);
  });

  it("includes writeControl when provided", async () => {
    FRESH_TOKEN();
    let body: unknown;
    server.use(
      http.post(BATCH_URL("doc_abc"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ documentId: "doc_abc", replies: [] });
      }),
    );
    await new DocsClient("alice").batchUpdate({
      documentId: "doc_abc",
      requests: [{ insertText: { text: "x", endOfSegmentLocation: {} } }],
      writeControl: { requiredRevisionId: "rev_1" },
    });
    expect(body).toEqual({
      requests: [{ insertText: { text: "x", endOfSegmentLocation: {} } }],
      writeControl: { requiredRevisionId: "rev_1" },
    });
  });

  it("maps a 403 scope error to an AuthError naming the docs-smart-auth CLI", async () => {
    FRESH_TOKEN();
    server.use(
      http.post(BATCH_URL("doc_abc"), () =>
        HttpResponse.json(
          { error: { code: 403, message: "insufficient" } },
          { status: 403 },
        ),
      ),
    );
    await expect(
      new DocsClient("alice").batchUpdate({
        documentId: "doc_abc",
        requests: [{ insertText: { text: "x", endOfSegmentLocation: {} } }],
      }),
    ).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("docs-smart-auth"),
    });
  });

  it("maps a SERVICE_DISABLED 403 to the 'enable the Docs API' AuthError", async () => {
    FRESH_TOKEN();
    server.use(
      http.post(BATCH_URL("doc_abc"), () =>
        HttpResponse.json(
          {
            error: {
              code: 403,
              message: "Google Docs API has not been used in project",
              status: "SERVICE_DISABLED",
            },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(
      new DocsClient("alice").batchUpdate({
        documentId: "doc_abc",
        requests: [{ insertText: { text: "x", endOfSegmentLocation: {} } }],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("docs.googleapis.com"),
    });
  });
});
