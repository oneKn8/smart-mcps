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
import { GDriveClient } from "../client.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/drive/v3";
const FILES_URL = `${API_BASE}/files`;
const FILE_URL = (id: string): string =>
  `${API_BASE}/files/${encodeURIComponent(id)}`;
const COPY_URL = (id: string): string => `${FILE_URL(id)}/copy`;
const GENERATE_IDS_URL = `${API_BASE}/files/generateIds`;
const TRASH_URL = `${API_BASE}/files/trash`;
const PERMISSIONS_URL = (id: string): string => `${FILE_URL(id)}/permissions`;
const PERMISSION_URL = (id: string, permId: string): string =>
  `${FILE_URL(id)}/permissions/${encodeURIComponent(permId)}`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-client-test-"));
}

function writeDriveTokenFile(
  home: string,
  account: string,
  payload: unknown,
): string {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${account}.gdrive.json`);
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
    scopes: ["https://www.googleapis.com/auth/drive"],
    expiry: opts.expiry,
  };
}

function writeGoodToken(account = "alice"): void {
  writeDriveTokenFile(
    tmpHome,
    account,
    fixtureFile({ expiry: "2026-06-30T13:00:00.000Z" }),
  );
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

describe("GDriveClient — constructor", () => {
  it("constructor is side-effect-free without HOME", () => {
    delete process.env.HOME;
    expect(() => new GDriveClient("alice")).not.toThrow();
  });

  it("getAccount returns the constructor account", () => {
    expect(new GDriveClient("alice").getAccount()).toBe("alice");
  });

  it("exposes the static API/upload/scope constants", () => {
    expect(GDriveClient.API_BASE).toBe(API_BASE);
    expect(GDriveClient.UPLOAD_BASE).toBe(
      "https://www.googleapis.com/upload/drive/v3/files",
    );
    expect(GDriveClient.REQUIRED_SCOPE).toBe(
      "https://www.googleapis.com/auth/drive",
    );
  });
});

describe("GDriveClient.createFolder", () => {
  it("POSTs a folder body with the folder mimeType and fields mask", async () => {
    writeGoodToken();
    let captured: unknown;
    let capturedUrl: URL | undefined;
    let bearer: string | null = null;
    server.use(
      http.post(FILES_URL, async ({ request }) => {
        bearer = request.headers.get("authorization");
        capturedUrl = new URL(request.url);
        captured = await request.json();
        return HttpResponse.json({ id: "folder_new", name: "Invoices" });
      }),
    );

    const c = new GDriveClient("alice", { home: tmpHome });
    const out = await c.createFolder({ name: "Invoices" });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({
      name: "Invoices",
      mimeType: "application/vnd.google-apps.folder",
    });
    expect(capturedUrl?.searchParams.get("fields")).toContain("parents");
    expect(out).toEqual({ id: "folder_new", name: "Invoices" });
  });

  it("includes parents when parentId is supplied", async () => {
    writeGoodToken();
    let captured: unknown;
    server.use(
      http.post(FILES_URL, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ id: "folder_new" });
      }),
    );

    const c = new GDriveClient("alice", { home: tmpHome });
    await c.createFolder({ name: "Sub", parentId: "folder_parent" });

    expect(captured).toEqual({
      name: "Sub",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["folder_parent"],
    });
  });

  it("propagates AuthError when the token file is missing", async () => {
    const c = new GDriveClient("ghost", { home: tmpHome });
    await expect(c.createFolder({ name: "x" })).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("wraps a 403 as AuthError mentioning the re-auth command", async () => {
    writeGoodToken();
    server.use(
      http.post(FILES_URL, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(c.createFolder({ name: "x" })).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("gdrive-smart-auth"),
    });
  });

  it("wraps a 401 as AuthError mentioning the account", async () => {
    writeGoodToken();
    server.use(
      http.post(FILES_URL, () =>
        HttpResponse.json(
          { error: { code: 401, message: "Invalid Credentials" } },
          { status: 401 },
        ),
      ),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(c.createFolder({ name: "x" })).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("alice"),
    });
  });
});

describe("GDriveClient.createShortcut", () => {
  it("POSTs a shortcut body with shortcutDetails.targetId", async () => {
    writeGoodToken();
    let captured: unknown;
    server.use(
      http.post(FILES_URL, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ id: "shortcut_new" });
      }),
    );

    const c = new GDriveClient("alice", { home: tmpHome });
    await c.createShortcut({
      name: "link",
      targetId: "file_target",
      parentId: "folder_parent",
    });

    expect(captured).toEqual({
      name: "link",
      mimeType: "application/vnd.google-apps.shortcut",
      shortcutDetails: { targetId: "file_target" },
      parents: ["folder_parent"],
    });
  });
});

describe("GDriveClient.generateIds", () => {
  it("GETs generateIds with space/type and forwards count, returning ids", async () => {
    writeGoodToken();
    let captured: URL | undefined;
    server.use(
      http.get(GENERATE_IDS_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ ids: ["id1", "id2"], space: "drive" });
      }),
    );

    const c = new GDriveClient("alice", { home: tmpHome });
    const out = await c.generateIds({ count: 2 });

    expect(captured?.searchParams.get("space")).toBe("drive");
    expect(captured?.searchParams.get("type")).toBe("files");
    expect(captured?.searchParams.get("count")).toBe("2");
    expect(out).toEqual({ ids: ["id1", "id2"] });
  });

  it("normalizes a missing ids array to []", async () => {
    writeGoodToken();
    server.use(http.get(GENERATE_IDS_URL, () => HttpResponse.json({})));
    const c = new GDriveClient("alice", { home: tmpHome });
    expect(await c.generateIds()).toEqual({ ids: [] });
  });
});

describe("GDriveClient.updateFile", () => {
  it("PATCHes a rename body with the fields mask, no parent query params", async () => {
    writeGoodToken();
    let captured: unknown;
    let capturedUrl: URL | undefined;
    server.use(
      http.patch(FILE_URL("file_alpha"), async ({ request }) => {
        capturedUrl = new URL(request.url);
        captured = await request.json();
        return HttpResponse.json({ id: "file_alpha", name: "Renamed" });
      }),
    );

    const c = new GDriveClient("alice", { home: tmpHome });
    const out = await c.updateFile("file_alpha", { name: "Renamed" });

    expect(captured).toEqual({ name: "Renamed" });
    expect(capturedUrl?.searchParams.get("fields")).toContain("parents");
    expect(capturedUrl?.searchParams.get("addParents")).toBeNull();
    expect(capturedUrl?.searchParams.get("removeParents")).toBeNull();
    expect(out).toEqual({ id: "file_alpha", name: "Renamed" });
  });

  it("sends addParents/removeParents as query params with an empty body (move)", async () => {
    writeGoodToken();
    let captured: unknown;
    let capturedUrl: URL | undefined;
    server.use(
      http.patch(FILE_URL("file_alpha"), async ({ request }) => {
        capturedUrl = new URL(request.url);
        captured = await request.json();
        return HttpResponse.json({ id: "file_alpha" });
      }),
    );

    const c = new GDriveClient("alice", { home: tmpHome });
    await c.updateFile(
      "file_alpha",
      {},
      { addParents: "folder_new", removeParents: "folder_old" },
    );

    expect(captured).toEqual({});
    expect(capturedUrl?.searchParams.get("addParents")).toBe("folder_new");
    expect(capturedUrl?.searchParams.get("removeParents")).toBe("folder_old");
  });

  it("URL-encodes the fileId", async () => {
    writeGoodToken();
    let capturedUrl: URL | undefined;
    server.use(
      http.patch(`${API_BASE}/files/:id`, ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ id: "x" });
      }),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await c.updateFile("a b/c", { starred: true });
    expect(capturedUrl?.pathname).toContain("a%20b%2Fc");
  });

  it("wraps a 404 as NotFoundError naming the file", async () => {
    writeGoodToken();
    server.use(
      http.patch(FILE_URL("file_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(
      c.updateFile("file_missing", { trashed: true }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("file_missing"),
    });
  });
});

describe("GDriveClient.copyFile", () => {
  it("POSTs to /copy with name+parents and the fields mask", async () => {
    writeGoodToken();
    let captured: unknown;
    server.use(
      http.post(COPY_URL("file_alpha"), async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ id: "file_copy" });
      }),
    );

    const c = new GDriveClient("alice", { home: tmpHome });
    const out = await c.copyFile("file_alpha", {
      name: "Copy",
      parentId: "folder_dest",
    });

    expect(captured).toEqual({ name: "Copy", parents: ["folder_dest"] });
    expect(out).toEqual({ id: "file_copy" });
  });

  it("wraps a 404 as NotFoundError naming the file", async () => {
    writeGoodToken();
    server.use(
      http.post(COPY_URL("file_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(c.copyFile("file_missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("GDriveClient.deleteFile", () => {
  it("DELETEs the file and returns nothing on 204", async () => {
    writeGoodToken();
    let bearer: string | null = null;
    server.use(
      http.delete(FILE_URL("file_alpha"), ({ request }) => {
        bearer = request.headers.get("authorization");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(c.deleteFile("file_alpha")).resolves.toBeUndefined();
    expect(bearer).toBe("Bearer test-access-token");
  });

  it("wraps a 404 as NotFoundError naming the file", async () => {
    writeGoodToken();
    server.use(
      http.delete(FILE_URL("file_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(c.deleteFile("file_missing")).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("file_missing"),
    });
  });
});

describe("GDriveClient.emptyTrash", () => {
  it("DELETEs /files/trash and returns nothing on 204", async () => {
    writeGoodToken();
    server.use(
      http.delete(TRASH_URL, () => new HttpResponse(null, { status: 204 })),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(c.emptyTrash()).resolves.toBeUndefined();
  });
});

describe("GDriveClient.getFile", () => {
  it("GETs the file with the default FILE_FIELDS mask", async () => {
    writeGoodToken();
    let capturedUrl: URL | undefined;
    server.use(
      http.get(FILE_URL("file_alpha"), ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ id: "file_alpha", name: "doc" });
      }),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    const out = await c.getFile("file_alpha");
    expect(capturedUrl?.searchParams.get("fields")).toContain("parents");
    expect(out).toEqual({ id: "file_alpha", name: "doc" });
  });

  it("forwards a custom fields mask when provided", async () => {
    writeGoodToken();
    let capturedUrl: URL | undefined;
    server.use(
      http.get(FILE_URL("file_alpha"), ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ id: "file_alpha" });
      }),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await c.getFile("file_alpha", "id,name");
    expect(capturedUrl?.searchParams.get("fields")).toBe("id,name");
  });

  it("wraps a 404 as NotFoundError naming the file", async () => {
    writeGoodToken();
    server.use(
      http.get(FILE_URL("file_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(c.getFile("file_missing")).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("file_missing"),
    });
  });
});

describe("GDriveClient.listFiles", () => {
  it("GETs /files with q, the LIST_FIELDS mask, and returns files+nextPageToken", async () => {
    writeGoodToken();
    let capturedUrl: URL | undefined;
    server.use(
      http.get(FILES_URL, ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({
          files: [{ id: "file_alpha" }],
          nextPageToken: "tok_next",
        });
      }),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    const out = await c.listFiles({ q: "'folder_x' in parents" });
    expect(capturedUrl?.searchParams.get("q")).toBe("'folder_x' in parents");
    expect(capturedUrl?.searchParams.get("fields")).toContain("files(");
    expect(out.files).toEqual([{ id: "file_alpha" }]);
    expect(out.nextPageToken).toBe("tok_next");
  });

  it("clamps pageSize above 100 down to 100", async () => {
    writeGoodToken();
    let capturedUrl: URL | undefined;
    server.use(
      http.get(FILES_URL, ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ files: [] });
      }),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await c.listFiles({ pageSize: 500 });
    expect(capturedUrl?.searchParams.get("pageSize")).toBe("100");
  });

  it("normalizes a missing files array to [] and omits nextPageToken", async () => {
    writeGoodToken();
    server.use(http.get(FILES_URL, () => HttpResponse.json({})));
    const c = new GDriveClient("alice", { home: tmpHome });
    const out = await c.listFiles();
    expect(out.files).toEqual([]);
    expect(out.nextPageToken).toBeUndefined();
  });
});

describe("GDriveClient — permissions", () => {
  it("createPermission POSTs role/type in body, notify+transfer as query", async () => {
    writeGoodToken();
    let captured: unknown;
    let capturedUrl: URL | undefined;
    server.use(
      http.post(PERMISSIONS_URL("file_alpha"), async ({ request }) => {
        capturedUrl = new URL(request.url);
        captured = await request.json();
        return HttpResponse.json({ id: "perm_new", type: "user", role: "writer" });
      }),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    const out = await c.createPermission("file_alpha", {
      role: "writer",
      type: "user",
      emailAddress: "bob@example.test",
      sendNotificationEmail: false,
      transferOwnership: false,
    });
    expect(captured).toEqual({
      role: "writer",
      type: "user",
      emailAddress: "bob@example.test",
    });
    expect(capturedUrl?.searchParams.get("sendNotificationEmail")).toBe("false");
    expect(capturedUrl?.searchParams.get("transferOwnership")).toBe("false");
    expect(capturedUrl?.searchParams.get("fields")).toBe(
      "id,type,role,emailAddress,domain",
    );
    expect(out).toEqual({ id: "perm_new", type: "user", role: "writer" });
  });

  it("listPermissions GETs with a permissions() fields mask and normalizes to []", async () => {
    writeGoodToken();
    let capturedUrl: URL | undefined;
    server.use(
      http.get(PERMISSIONS_URL("file_alpha"), ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ permissions: [{ id: "perm_a" }] });
      }),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    const out = await c.listPermissions("file_alpha");
    expect(capturedUrl?.searchParams.get("fields")).toBe(
      "permissions(id,type,role,emailAddress,domain)",
    );
    expect(out).toEqual([{ id: "perm_a" }]);
  });

  it("listPermissions normalizes a missing permissions array to []", async () => {
    writeGoodToken();
    server.use(
      http.get(PERMISSIONS_URL("file_alpha"), () => HttpResponse.json({})),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    expect(await c.listPermissions("file_alpha")).toEqual([]);
  });

  it("updatePermission PATCHes role in body, transferOwnership as query", async () => {
    writeGoodToken();
    let captured: unknown;
    let capturedUrl: URL | undefined;
    server.use(
      http.patch(PERMISSION_URL("file_alpha", "perm_a"), async ({ request }) => {
        capturedUrl = new URL(request.url);
        captured = await request.json();
        return HttpResponse.json({ id: "perm_a", role: "owner" });
      }),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await c.updatePermission("file_alpha", "perm_a", {
      role: "owner",
      transferOwnership: true,
    });
    expect(captured).toEqual({ role: "owner" });
    expect(capturedUrl?.searchParams.get("transferOwnership")).toBe("true");
  });

  it("deletePermission DELETEs and returns nothing on 204", async () => {
    writeGoodToken();
    server.use(
      http.delete(
        PERMISSION_URL("file_alpha", "perm_a"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(
      c.deletePermission("file_alpha", "perm_a"),
    ).resolves.toBeUndefined();
  });

  it("deletePermission wraps a 404 as NotFoundError naming the permission", async () => {
    writeGoodToken();
    server.use(
      http.delete(PERMISSION_URL("file_alpha", "perm_ghost"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );
    const c = new GDriveClient("alice", { home: tmpHome });
    await expect(
      c.deletePermission("file_alpha", "perm_ghost"),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("perm_ghost"),
    });
  });
});
