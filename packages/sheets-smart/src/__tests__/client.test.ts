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
import { SheetsClient } from "../client.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

const SPREADSHEETS_URL = `${SHEETS_API_BASE}/spreadsheets`;
const SPREADSHEET_URL = (id: string): string =>
  `${SHEETS_API_BASE}/spreadsheets/${id}`;
const VALUES_URL = (id: string, range: string): string =>
  `${SHEETS_API_BASE}/spreadsheets/${id}/values/${range}`;
const DRIVE_FILES_URL = `${DRIVE_API_BASE}/files`;
const DRIVE_FILE_URL = (id: string): string => `${DRIVE_API_BASE}/files/${id}`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sheets-client-test-"));
}

function writeSheetsTokenFile(
  home: string,
  account: string,
  payload: unknown,
): string {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${account}.sheets.json`);
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
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
    expiry: opts.expiry,
  };
}

const FUTURE = "2030-06-27T13:00:00.000Z";

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-27T12:00:00.000Z"));
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

describe("SheetsClient — constructor", () => {
  it("is side-effect-free without HOME", () => {
    delete process.env.HOME;
    expect(() => new SheetsClient("alice")).not.toThrow();
  });

  it("getAccount returns the constructor account", () => {
    expect(new SheetsClient("alice").getAccount()).toBe("alice");
  });
});

describe("SheetsClient.createSpreadsheet", () => {
  it("POSTs /spreadsheets with a Bearer token and returns the resource", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let bearer: string | null = null;
    let captured: unknown;
    server.use(
      http.post(SPREADSHEETS_URL, async ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = await request.json();
        return HttpResponse.json({
          spreadsheetId: "SID",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/SID/edit",
          sheets: [{ properties: { sheetId: 0, title: "Ledger" } }],
        });
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.createSpreadsheet({ properties: { title: "Ledger" } });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({ properties: { title: "Ledger" } });
    expect(out.spreadsheetId).toBe("SID");
    expect(out.sheets?.[0]).toEqual({
      properties: { sheetId: 0, title: "Ledger" },
    });
  });

  it("propagates AuthError when the token file is missing", async () => {
    const c = new SheetsClient("ghost", { home: tmpHome });
    await expect(
      c.createSpreadsheet({ properties: { title: "x" } }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("SheetsClient.getSpreadsheet", () => {
  it("GETs /spreadsheets/{id} and forwards the fields mask", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let captured: URL | undefined;
    server.use(
      http.get(SPREADSHEET_URL("SID"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({
          spreadsheetId: "SID",
          properties: { title: "Ledger" },
          sheets: [],
        });
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.getSpreadsheet("SID", {
      fields: "spreadsheetId,properties.title",
    });
    expect(captured?.searchParams.get("fields")).toBe(
      "spreadsheetId,properties.title",
    );
    expect(out.spreadsheetId).toBe("SID");
  });

  it("wraps a 404 as NotFoundError naming the spreadsheet", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    server.use(
      http.get(SPREADSHEET_URL("missing"), () =>
        HttpResponse.json({ error: { code: 404 } }, { status: 404 }),
      ),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    await expect(c.getSpreadsheet("missing")).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("missing"),
    });
  });
});

describe("SheetsClient.getValues", () => {
  it("GETs /values/{range} and returns the ValueRange shape", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let bearer: string | null = null;
    let captured: URL | undefined;
    server.use(
      http.get(VALUES_URL("SID", "Ledger!A1:B2"), ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = new URL(request.url);
        return HttpResponse.json({
          range: "Ledger!A1:B2",
          majorDimension: "ROWS",
          values: [
            ["Original", 1657],
            ["Paid", 257],
          ],
        });
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.getValues("SID", "Ledger!A1:B2", {
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured?.searchParams.get("valueRenderOption")).toBe(
      "UNFORMATTED_VALUE",
    );
    expect(out.range).toBe("Ledger!A1:B2");
    expect(out.values).toEqual([
      ["Original", 1657],
      ["Paid", 257],
    ]);
  });

  it("URL-encodes a range containing special characters", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let captured: URL | undefined;
    server.use(
      http.get(`${SHEETS_API_BASE}/spreadsheets/SID/values/:range`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ values: [] });
      }),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    await c.getValues("SID", "'My Sheet'!A1");
    expect(captured?.pathname).toContain("'My%20Sheet'!A1");
  });
});

describe("SheetsClient.updateValues", () => {
  it("PUTs /values/{range} with valueInputOption and a ValueRange body", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let captured: URL | undefined;
    let body: unknown;
    server.use(
      http.put(VALUES_URL("SID", "Sheet1!A1:B1"), async ({ request }) => {
        captured = new URL(request.url);
        body = await request.json();
        return HttpResponse.json({
          updatedRange: "Sheet1!A1:B1",
          updatedCells: 2,
        });
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.updateValues(
      "SID",
      "Sheet1!A1:B1",
      [["a", "b"]],
      "USER_ENTERED",
    );
    expect(captured?.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    expect(body).toEqual({ range: "Sheet1!A1:B1", values: [["a", "b"]] });
    expect(out.updatedCells).toBe(2);
  });
});

describe("SheetsClient.appendValues", () => {
  it("POSTs /values/{range}:append with both options and returns updates", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let captured: URL | undefined;
    server.use(
      http.post(`${VALUES_URL("SID", "Sheet1")}:append`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({
          updates: { updatedRange: "Sheet1!A5:B5", updatedRows: 1 },
        });
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.appendValues(
      "SID",
      "Sheet1",
      [["x", "y"]],
      "USER_ENTERED",
      "INSERT_ROWS",
    );
    expect(captured?.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    expect(captured?.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
    expect(out.updates?.updatedRange).toBe("Sheet1!A5:B5");
    expect(out.updates?.updatedRows).toBe(1);
  });
});

describe("SheetsClient.batchUpdateValues", () => {
  it("POSTs /values:batchUpdate with data + valueInputOption", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let body: unknown;
    server.use(
      http.post(`${SPREADSHEET_URL("SID")}/values:batchUpdate`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ totalUpdatedCells: 4 });
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.batchUpdateValues(
      "SID",
      [{ range: "Sheet1!A1", values: [["a"]] }],
      "RAW",
    );
    expect(body).toEqual({
      valueInputOption: "RAW",
      data: [{ range: "Sheet1!A1", values: [["a"]] }],
    });
    expect(out.totalUpdatedCells).toBe(4);
  });
});

describe("SheetsClient.clearValues", () => {
  it("POSTs /values/{range}:clear and returns the cleared range", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    // Use a colon-free range here: msw's path matcher would otherwise read the
    // adjacent ":B2:clear" colons as path params and fail to match.
    server.use(
      http.post(`${VALUES_URL("SID", "Ledger")}:clear`, () =>
        HttpResponse.json({ clearedRange: "Ledger!A1:Z100" }),
      ),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.clearValues("SID", "Ledger");
    expect(out.clearedRange).toBe("Ledger!A1:Z100");
  });
});

describe("SheetsClient.batchUpdate", () => {
  it("POSTs /{id}:batchUpdate with the requests array and returns replies", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let body: unknown;
    server.use(
      http.post(`${SPREADSHEET_URL("SID")}:batchUpdate`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          spreadsheetId: "SID",
          replies: [{ addSheet: { properties: { sheetId: 7, title: "Tab2" } } }],
        });
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.batchUpdate("SID", [{ addSheet: { properties: { title: "Tab2" } } }]);
    expect(body).toEqual({
      requests: [{ addSheet: { properties: { title: "Tab2" } } }],
    });
    expect(out.replies?.[0]).toEqual({
      addSheet: { properties: { sheetId: 7, title: "Tab2" } },
    });
  });

  it("wraps a 401 as AuthError naming the reauth command", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    server.use(
      http.post(`${SPREADSHEET_URL("SID")}:batchUpdate`, () =>
        HttpResponse.json(
          { error: { code: 401, message: "Invalid Credentials" } },
          { status: 401 },
        ),
      ),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    await expect(c.batchUpdate("SID", [{}])).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("sheets-smart-auth"),
    });
  });

  it("wraps a 403 as AuthError mentioning insufficient scope", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    server.use(
      http.post(`${SPREADSHEET_URL("SID")}:batchUpdate`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    await expect(c.batchUpdate("SID", [{}])).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("sheets-smart-auth"),
    });
  });
});

describe("SheetsClient.listFiles", () => {
  it("GETs /files with q + fields + orderBy and normalizes files to []", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let captured: URL | undefined;
    server.use(
      http.get(DRIVE_FILES_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({});
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.listFiles("mimeType='x' and trashed=false", {
      pageSize: 50,
      orderBy: "modifiedTime desc",
      fields: "nextPageToken,files(id,name)",
    });
    expect(captured?.searchParams.get("q")).toBe(
      "mimeType='x' and trashed=false",
    );
    expect(captured?.searchParams.get("pageSize")).toBe("50");
    expect(captured?.searchParams.get("orderBy")).toBe("modifiedTime desc");
    expect(captured?.searchParams.get("fields")).toBe("nextPageToken,files(id,name)");
    expect(out.files).toEqual([]);
    expect(out.nextPageToken).toBeUndefined();
  });

  it("returns files + nextPageToken when present", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    server.use(
      http.get(DRIVE_FILES_URL, () =>
        HttpResponse.json({
          files: [{ id: "f1", name: "Ledger" }],
          nextPageToken: "tok",
        }),
      ),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.listFiles("q");
    expect(out.files).toEqual([{ id: "f1", name: "Ledger" }]);
    expect(out.nextPageToken).toBe("tok");
  });
});

describe("SheetsClient.updateFile", () => {
  it("PATCHes /files/{id} with addParents on the query string", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let captured: URL | undefined;
    let body: unknown;
    server.use(
      http.patch(DRIVE_FILE_URL("f1"), async ({ request }) => {
        captured = new URL(request.url);
        body = await request.json();
        return HttpResponse.json({ id: "f1", parents: ["folderA"] });
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.updateFile("f1", {}, { addParents: "folderA" });
    expect(captured?.searchParams.get("addParents")).toBe("folderA");
    expect(body).toEqual({});
    expect(out.id).toBe("f1");
  });
});

describe("SheetsClient.trashFile / deleteFile", () => {
  it("trashFile PATCHes {trashed:true}", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let body: unknown;
    server.use(
      http.patch(DRIVE_FILE_URL("f1"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "f1", trashed: true });
      }),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.trashFile("f1");
    expect(body).toEqual({ trashed: true });
    expect(out.trashed).toBe(true);
  });

  it("deleteFile DELETEs and resolves void on 204", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    server.use(
      http.delete(DRIVE_FILE_URL("f1"), () => new HttpResponse(null, { status: 204 })),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    await expect(c.deleteFile("f1")).resolves.toBeUndefined();
  });
});

describe("SheetsClient.createPermission / getWebViewLink", () => {
  it("createPermission POSTs /permissions with sendNotificationEmail", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let captured: URL | undefined;
    let body: unknown;
    server.use(
      http.post(`${DRIVE_FILE_URL("f1")}/permissions`, async ({ request }) => {
        captured = new URL(request.url);
        body = await request.json();
        return HttpResponse.json({ id: "perm1", role: "writer", type: "user" });
      }),
    );

    const c = new SheetsClient("alice", { home: tmpHome });
    const out = await c.createPermission(
      "f1",
      { role: "writer", type: "user", emailAddress: "bob@example.test" },
      { sendNotificationEmail: false },
    );
    expect(captured?.searchParams.get("sendNotificationEmail")).toBe("false");
    expect(body).toEqual({
      role: "writer",
      type: "user",
      emailAddress: "bob@example.test",
    });
    expect(out.id).toBe("perm1");
  });

  it("getWebViewLink GETs /files/{id}?fields=webViewLink and returns the link", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    let captured: URL | undefined;
    server.use(
      http.get(DRIVE_FILE_URL("f1"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({
          webViewLink: "https://docs.google.com/spreadsheets/d/f1/edit",
        });
      }),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    const link = await c.getWebViewLink("f1");
    expect(captured?.searchParams.get("fields")).toBe("webViewLink");
    expect(link).toBe("https://docs.google.com/spreadsheets/d/f1/edit");
  });

  it("getWebViewLink returns '' when the field is absent", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    server.use(http.get(DRIVE_FILE_URL("f1"), () => HttpResponse.json({})));
    const c = new SheetsClient("alice", { home: tmpHome });
    expect(await c.getWebViewLink("f1")).toBe("");
  });
});

describe("SheetsClient — NotFoundError instance check", () => {
  it("getWebViewLink wraps a 404 as NotFoundError", async () => {
    writeSheetsTokenFile(tmpHome, "alice", fixtureFile({ expiry: FUTURE }));
    server.use(
      http.get(DRIVE_FILE_URL("missing"), () =>
        HttpResponse.json({ error: { code: 404 } }, { status: 404 }),
      ),
    );
    const c = new SheetsClient("alice", { home: tmpHome });
    await expect(c.getWebViewLink("missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
