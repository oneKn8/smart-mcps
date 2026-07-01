import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse, delay } from "msw";
import { ValidationError, UpstreamError } from "smart-mcp-core";
import {
  isBlockedIp,
  isBlockedHostname,
  fetchRemoteFile,
  type DnsLookupFn,
} from "../safe-fetch.js";

// A lookup that always resolves to a public address, and a factory to point a
// host at a chosen (possibly private) address to exercise DNS-based SSRF.
const PUBLIC_V4 = "93.184.216.34";
const publicLookup: DnsLookupFn = async () => [
  { address: PUBLIC_V4, family: 4 },
];
function lookupReturning(address: string, family = 4): DnsLookupFn {
  return async () => [{ address, family }];
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// isBlockedIp — pure classification
// ---------------------------------------------------------------------------

describe("isBlockedIp — blocked IPv4 ranges", () => {
  it.each([
    "127.0.0.1",
    "127.5.5.5",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "255.255.255.255",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });
});

describe("isBlockedIp — allowed public IPv4", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255", // just below 172.16/12
    "172.32.0.1", // just above 172.16/12
    "192.169.0.1", // not 192.168/16
    "100.63.255.255", // below CGNAT
    "100.128.0.1", // above CGNAT
  ])("allows %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("isBlockedIp — IPv6", () => {
  it.each([
    "::1", // loopback
    "::", // unspecified
    "fc00::1", // ULA
    "fd12:3456::1", // ULA
    "fe80::1", // link-local
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1", // IPv4-mapped private
    "::ffff:169.254.169.254", // IPv4-mapped metadata
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe("isBlockedIp — malformed input fails closed", () => {
  it.each(["", "not-an-ip", "999.999.999.999", "10.0.0", "::gggg"])(
    "blocks %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// isBlockedHostname
// ---------------------------------------------------------------------------

describe("isBlockedHostname", () => {
  it.each(["localhost", "LOCALHOST", "foo.localhost", "a.b.localhost", "localhost."])(
    "blocks %s",
    (h) => {
      expect(isBlockedHostname(h)).toBe(true);
    },
  );

  it.each(["example.com", "localhost.example.com", "notlocalhost", "cdn.test"])(
    "allows %s",
    (h) => {
      expect(isBlockedHostname(h)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// fetchRemoteFile — happy path
// ---------------------------------------------------------------------------

describe("fetchRemoteFile — happy path", () => {
  it("fetches bytes from a public host", async () => {
    server.use(
      http.get("http://files.test/logo.png", () =>
        HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3, 4, 5]).buffer, {
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    const { bytes } = await fetchRemoteFile("http://files.test/logo.png", {
      lookup: publicLookup,
    });
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("fetches from an https public IP literal without DNS", async () => {
    server.use(
      http.get("https://93.184.216.34/a.bin", () =>
        HttpResponse.arrayBuffer(new Uint8Array([9, 9]).buffer),
      ),
    );
    // lookup should never be called for an IP literal — pass one that would throw.
    const { bytes } = await fetchRemoteFile("https://93.184.216.34/a.bin", {
      lookup: async () => {
        throw new Error("lookup must not be called for IP literals");
      },
    });
    expect(Array.from(bytes)).toEqual([9, 9]);
  });
});

// ---------------------------------------------------------------------------
// fetchRemoteFile — SSRF rejection (no network reached)
// ---------------------------------------------------------------------------

describe("fetchRemoteFile — SSRF rejection", () => {
  it.each([
    "http://127.0.0.1/x",
    "http://10.0.0.5/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x",
    "http://192.168.1.1/x",
  ])("rejects blocked IP literal %s", async (url) => {
    await expect(
      fetchRemoteFile(url, { lookup: publicLookup }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expect(
      fetchRemoteFile("http://evil.test/x", {
        lookup: lookupReturning("10.1.2.3"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a hostname whose records mix public and private", async () => {
    const mixed: DnsLookupFn = async () => [
      { address: PUBLIC_V4, family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(
      fetchRemoteFile("http://mixed.test/x", { lookup: mixed }),
    ).rejects.toThrow(ValidationError);
  });

  it.each(["file:///etc/passwd", "ftp://files.test/x", "gopher://x/1"])(
    "rejects non-http(s) scheme %s",
    async (url) => {
      await expect(
        fetchRemoteFile(url, { lookup: publicLookup }),
      ).rejects.toThrow(ValidationError);
    },
  );

  it("rejects a *.localhost host", async () => {
    await expect(
      fetchRemoteFile("http://api.localhost/x", { lookup: publicLookup }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an unresolvable host with UpstreamError", async () => {
    await expect(
      fetchRemoteFile("http://nope.test/x", { lookup: async () => [] }),
    ).rejects.toThrow(UpstreamError);
  });
});

// ---------------------------------------------------------------------------
// fetchRemoteFile — size cap
// ---------------------------------------------------------------------------

describe("fetchRemoteFile — size cap", () => {
  it("aborts a body larger than maxBytes", async () => {
    server.use(
      http.get("http://big.test/huge.bin", () =>
        HttpResponse.arrayBuffer(new Uint8Array(2000).buffer),
      ),
    );
    await expect(
      fetchRemoteFile("http://big.test/huge.bin", {
        lookup: publicLookup,
        maxBytes: 100,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects when the declared content-length exceeds maxBytes", async () => {
    server.use(
      http.get("http://big.test/declared.bin", () =>
        HttpResponse.arrayBuffer(new Uint8Array(50).buffer, {
          headers: { "content-length": "9999999999" },
        }),
      ),
    );
    await expect(
      fetchRemoteFile("http://big.test/declared.bin", {
        lookup: publicLookup,
        maxBytes: 100,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("accepts a body exactly at the cap", async () => {
    server.use(
      http.get("http://ok.test/exact.bin", () =>
        HttpResponse.arrayBuffer(new Uint8Array(100).buffer),
      ),
    );
    const { bytes } = await fetchRemoteFile("http://ok.test/exact.bin", {
      lookup: publicLookup,
      maxBytes: 100,
    });
    expect(bytes.length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// fetchRemoteFile — redirects
// ---------------------------------------------------------------------------

describe("fetchRemoteFile — redirects", () => {
  it("follows a redirect to another allowed host", async () => {
    server.use(
      http.get(
        "http://start.test/go",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: "http://cdn.test/file.bin" },
          }),
      ),
      http.get("http://cdn.test/file.bin", () =>
        HttpResponse.arrayBuffer(new Uint8Array([7, 7, 7]).buffer),
      ),
    );
    const { bytes } = await fetchRemoteFile("http://start.test/go", {
      lookup: publicLookup,
    });
    expect(Array.from(bytes)).toEqual([7, 7, 7]);
  });

  it("rejects a redirect that lands on a blocked address", async () => {
    server.use(
      http.get(
        "http://start.test/evil",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: "http://169.254.169.254/latest/" },
          }),
      ),
    );
    await expect(
      fetchRemoteFile("http://start.test/evil", { lookup: publicLookup }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a redirect chain that exceeds the hop limit", async () => {
    server.use(
      http.get(
        "http://loop.test/x",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: "http://loop.test/x" },
          }),
      ),
    );
    await expect(
      fetchRemoteFile("http://loop.test/x", { lookup: publicLookup }),
    ).rejects.toThrow(UpstreamError);
  });

  it("rejects a redirect with no Location header", async () => {
    server.use(
      http.get(
        "http://start.test/noloc",
        () => new HttpResponse(null, { status: 302 }),
      ),
    );
    await expect(
      fetchRemoteFile("http://start.test/noloc", { lookup: publicLookup }),
    ).rejects.toThrow(UpstreamError);
  });
});

// ---------------------------------------------------------------------------
// fetchRemoteFile — timeout + upstream errors
// ---------------------------------------------------------------------------

describe("fetchRemoteFile — timeout and status", () => {
  it("times out a slow response", async () => {
    server.use(
      http.get("http://slow.test/x", async () => {
        await delay(300);
        return HttpResponse.arrayBuffer(new Uint8Array([1]).buffer);
      }),
    );
    await expect(
      fetchRemoteFile("http://slow.test/x", {
        lookup: publicLookup,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(UpstreamError);
  });

  it("maps a non-2xx status to UpstreamError", async () => {
    server.use(
      http.get("http://err.test/x", () =>
        HttpResponse.text("nope", { status: 404 }),
      ),
    );
    await expect(
      fetchRemoteFile("http://err.test/x", { lookup: publicLookup }),
    ).rejects.toThrow(UpstreamError);
  });
});
