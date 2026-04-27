import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { makeServer, http, HttpResponse } from "./test-helpers.js";
import { fetchJson } from "../http.js";
import { AuthError, NotFoundError, RateLimitError, UpstreamError, ValidationError } from "../errors.js";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("fetchJson — happy path", () => {
  it("returns parsed JSON on 200", async () => {
    server.use(
      http.get("https://api.test/items", () =>
        HttpResponse.json({ items: [{ id: 1 }] }),
      ),
    );
    const result = await fetchJson<{ items: { id: number }[] }>("https://api.test/items");
    expect(result.items[0]?.id).toBe(1);
  });

  it("injects bearer auth header from token option", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://api.test/x", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true });
      }),
    );
    await fetchJson("https://api.test/x", { token: "tkn_123" });
    expect(seenAuth).toBe("Bearer tkn_123");
  });
});

describe("fetchJson — error mapping", () => {
  it("throws AuthError on 401", async () => {
    server.use(
      http.get("https://api.test/auth", () =>
        HttpResponse.json({ error: "bad token" }, { status: 401 }),
      ),
    );
    await expect(fetchJson("https://api.test/auth")).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError on 403", async () => {
    server.use(
      http.get("https://api.test/forbidden", () =>
        HttpResponse.json({ error: "forbidden" }, { status: 403 }),
      ),
    );
    await expect(fetchJson("https://api.test/forbidden")).rejects.toBeInstanceOf(AuthError);
  });

  it("throws NotFoundError on 404", async () => {
    server.use(
      http.get("https://api.test/missing", () =>
        HttpResponse.json({ error: "missing" }, { status: 404 }),
      ),
    );
    await expect(fetchJson("https://api.test/missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ValidationError on 400", async () => {
    server.use(
      http.get("https://api.test/bad", () =>
        HttpResponse.json({ error: "bad input" }, { status: 400 }),
      ),
    );
    await expect(fetchJson("https://api.test/bad")).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws RateLimitError on 429 with retryAfter parsed", async () => {
    server.use(
      http.get("https://api.test/rate", () =>
        new HttpResponse(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "retry-after": "47", "content-type": "application/json" },
        }),
      ),
    );
    try {
      await fetchJson("https://api.test/rate", { retries: 0 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterSec).toBe(47);
    }
  });
});

describe("fetchJson — retries", () => {
  it("retries 5xx up to retries count, then throws UpstreamError", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.test/flaky", () => {
        calls++;
        return HttpResponse.json({ error: "boom" }, { status: 503 });
      }),
    );
    await expect(
      fetchJson("https://api.test/flaky", { retries: 2, baseDelayMs: 1 }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("succeeds on retry after transient 503", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.test/transient", () => {
        calls++;
        if (calls < 2) return HttpResponse.json({ error: "boom" }, { status: 503 });
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await fetchJson<{ ok: boolean }>("https://api.test/transient", {
      retries: 2,
      baseDelayMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
