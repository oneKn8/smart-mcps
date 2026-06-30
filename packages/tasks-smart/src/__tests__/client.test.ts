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
import { TasksClient } from "../client.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://tasks.googleapis.com/tasks/v1";
const LISTS_URL = `${API_BASE}/users/@me/lists`;
const LIST_URL = (id: string): string => `${LISTS_URL}/${id}`;
const TASKS_URL = (list: string): string => `${API_BASE}/lists/${list}/tasks`;
const TASK_URL = (list: string, task: string): string =>
  `${API_BASE}/lists/${list}/tasks/${task}`;
const MOVE_URL = (list: string, task: string): string =>
  `${API_BASE}/lists/${list}/tasks/${task}/move`;
const CLEAR_URL = (list: string): string => `${API_BASE}/lists/${list}/clear`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tasks-client-test-"));
}

function writeTasksTokenFile(
  home: string,
  account: string,
  payload: unknown,
): string {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${account}.tasks.json`);
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
    scopes: ["https://www.googleapis.com/auth/tasks"],
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

function freshToken() {
  return fixtureFile({ expiry: "2026-06-30T13:00:00.000Z" });
}

describe("TasksClient — constructor", () => {
  it("is side-effect-free without HOME", () => {
    delete process.env.HOME;
    expect(() => new TasksClient("alice")).not.toThrow();
  });

  it("getAccount returns the constructor account", () => {
    expect(new TasksClient("alice").getAccount()).toBe("alice");
  });

  it("exposes the API base + token suffix as static metadata", () => {
    expect(TasksClient.API_BASE).toBe(API_BASE);
    expect(TasksClient.TOKEN_FILE_SUFFIX).toBe(".tasks.json");
  });
});

describe("TasksClient.listTaskLists", () => {
  it("GETs /users/@me/lists with bearer and normalizes items + token", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    let bearer: string | null = null;
    let captured: URL | undefined;
    server.use(
      http.get(LISTS_URL, ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = new URL(request.url);
        return HttpResponse.json({
          items: [{ id: "l1", title: "A" }],
          nextPageToken: "tok",
        });
      }),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    const out = await c.listTaskLists();
    expect(bearer).toBe("Bearer test-access-token");
    expect(captured?.pathname).toBe("/tasks/v1/users/@me/lists");
    expect(out.items).toEqual([{ id: "l1", title: "A" }]);
    expect(out.nextPageToken).toBe("tok");
  });

  it("normalizes a missing items array to []", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(http.get(LISTS_URL, () => HttpResponse.json({})));
    const c = new TasksClient("alice", { home: tmpHome });
    const out = await c.listTaskLists();
    expect(out.items).toEqual([]);
    expect(out.nextPageToken).toBeUndefined();
  });

  it("propagates AuthError when the tasks token file is missing", async () => {
    const c = new TasksClient("ghost", { home: tmpHome });
    await expect(c.listTaskLists()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("TasksClient.getTaskList", () => {
  it("GETs a single list and returns it raw", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(
      http.get(LIST_URL("l1"), () =>
        HttpResponse.json({ id: "l1", title: "A" }),
      ),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    expect(await c.getTaskList("l1")).toEqual({ id: "l1", title: "A" });
  });

  it("rewrites a 404 into NotFoundError naming the list", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(
      http.get(LIST_URL("missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(c.getTaskList("missing")).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("missing"),
    });
  });
});

describe("TasksClient.insertTaskList / patchTaskList / deleteTaskList", () => {
  it("POSTs the body to /users/@me/lists", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    let body: unknown;
    server.use(
      http.post(LISTS_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "new", title: "Fresh" });
      }),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    const out = await c.insertTaskList({ title: "Fresh" });
    expect(body).toEqual({ title: "Fresh" });
    expect(out).toEqual({ id: "new", title: "Fresh" });
  });

  it("PATCHes a list and 404s as NotFoundError", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(
      http.patch(LIST_URL("missing"), () =>
        HttpResponse.json({ error: { code: 404 } }, { status: 404 }),
      ),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(
      c.patchTaskList({ tasklist: "missing", body: { title: "x" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("DELETEs a list (204 -> void)", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    let method: string | undefined;
    server.use(
      http.delete(LIST_URL("l1"), ({ request }) => {
        method = request.method;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(c.deleteTaskList({ tasklist: "l1" })).resolves.toBeUndefined();
    expect(method).toBe("DELETE");
  });
});

describe("TasksClient.listTasks", () => {
  it("forwards show_* + due window + maxResults query params", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    let captured: URL | undefined;
    server.use(
      http.get(TASKS_URL("l1"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ items: [{ id: "t1" }] });
      }),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    const out = await c.listTasks({
      tasklist: "l1",
      showCompleted: false,
      showHidden: true,
      dueMin: "2026-06-30T00:00:00.000Z",
      dueMax: "2026-07-01T00:00:00.000Z",
      maxResults: 50,
    });
    expect(captured?.searchParams.get("showCompleted")).toBe("false");
    expect(captured?.searchParams.get("showHidden")).toBe("true");
    expect(captured?.searchParams.get("dueMin")).toBe(
      "2026-06-30T00:00:00.000Z",
    );
    expect(captured?.searchParams.get("dueMax")).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(captured?.searchParams.get("maxResults")).toBe("50");
    expect(out.items).toEqual([{ id: "t1" }]);
  });

  it("404 on the list rewrites to NotFoundError", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(
      http.get(TASKS_URL("missing"), () =>
        HttpResponse.json({ error: { code: 404 } }, { status: 404 }),
      ),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(c.listTasks({ tasklist: "missing" })).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("missing"),
    });
  });
});

describe("TasksClient.insertTask", () => {
  it("POSTs the body and forwards parent/previous as query params", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    let captured: URL | undefined;
    let body: unknown;
    server.use(
      http.post(TASKS_URL("l1"), async ({ request }) => {
        captured = new URL(request.url);
        body = await request.json();
        return HttpResponse.json({ id: "t_new", title: "Do it" });
      }),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    const out = await c.insertTask({
      tasklist: "l1",
      body: { title: "Do it", due: "2026-06-30T00:00:00.000Z" },
      parent: "p1",
      previous: "s1",
    });
    expect(body).toEqual({ title: "Do it", due: "2026-06-30T00:00:00.000Z" });
    expect(captured?.searchParams.get("parent")).toBe("p1");
    expect(captured?.searchParams.get("previous")).toBe("s1");
    expect(out).toEqual({ id: "t_new", title: "Do it" });
  });
});

describe("TasksClient.getTask / patchTask / deleteTask", () => {
  it("GETs a task and 404s with both ids in the message", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(
      http.get(TASK_URL("l1", "missing"), () =>
        HttpResponse.json({ error: { code: 404 } }, { status: 404 }),
      ),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(
      c.getTask({ tasklist: "l1", task: "missing" }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("missing"),
    });
  });

  it("PATCHes a task with the given body", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    let body: unknown;
    server.use(
      http.patch(TASK_URL("l1", "t1"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "t1", status: "completed" });
      }),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    const out = await c.patchTask({
      tasklist: "l1",
      task: "t1",
      body: { status: "completed" },
    });
    expect(body).toEqual({ status: "completed" });
    expect(out).toEqual({ id: "t1", status: "completed" });
  });

  it("DELETEs a task (204 -> void)", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(
      http.delete(TASK_URL("l1", "t1"), () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(
      c.deleteTask({ tasklist: "l1", task: "t1" }),
    ).resolves.toBeUndefined();
  });
});

describe("TasksClient.moveTask", () => {
  it("POSTs to /move with parent + previous + destinationTasklist query", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    let captured: URL | undefined;
    let method: string | undefined;
    server.use(
      http.post(MOVE_URL("l1", "t1"), ({ request }) => {
        captured = new URL(request.url);
        method = request.method;
        return HttpResponse.json({ id: "t1", parent: "p1" });
      }),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    const out = await c.moveTask({
      tasklist: "l1",
      task: "t1",
      parent: "p1",
      previous: "s1",
      destinationTasklist: "l2",
    });
    expect(method).toBe("POST");
    expect(captured?.searchParams.get("parent")).toBe("p1");
    expect(captured?.searchParams.get("previous")).toBe("s1");
    expect(captured?.searchParams.get("destinationTasklist")).toBe("l2");
    expect(out).toEqual({ id: "t1", parent: "p1" });
  });
});

describe("TasksClient.clearTasks", () => {
  it("POSTs to /lists/{tasklist}/clear (NOT under /tasks) and resolves void", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    let pathname: string | undefined;
    let method: string | undefined;
    server.use(
      http.post(CLEAR_URL("l1"), ({ request }) => {
        pathname = new URL(request.url).pathname;
        method = request.method;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(c.clearTasks({ tasklist: "l1" })).resolves.toBeUndefined();
    expect(method).toBe("POST");
    expect(pathname).toBe("/tasks/v1/lists/l1/clear");
  });
});

describe("TasksClient — auth error mapping", () => {
  it("wraps a 403 as AuthError mentioning the re-auth command", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(
      http.get(LISTS_URL, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(c.listTaskLists()).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("tasks-smart-auth"),
    });
  });

  it("wraps a 401 as AuthError mentioning the account", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(
      http.get(LISTS_URL, () =>
        HttpResponse.json(
          { error: { code: 401, message: "Invalid Credentials" } },
          { status: 401 },
        ),
      ),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(c.listTaskLists()).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("alice"),
    });
  });

  it("surfaces a SERVICE_DISABLED 403 as an enable-the-API AuthError", async () => {
    writeTasksTokenFile(tmpHome, "alice", freshToken());
    server.use(
      http.get(LISTS_URL, () =>
        HttpResponse.json(
          {
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message:
                "Google Tasks API has not been used in project 123 before or it is disabled. SERVICE_DISABLED",
            },
          },
          { status: 403 },
        ),
      ),
    );
    const c = new TasksClient("alice", { home: tmpHome });
    await expect(c.listTaskLists()).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("not enabled"),
    });
  });
});
