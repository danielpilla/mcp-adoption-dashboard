import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./http-server";
import {
  CursorApiClient,
  CursorApiError,
  type TeamMetadata,
} from "../cursor/cursor-api";
import type { McpResponse } from "../../contracts/mcp-response";

let server: Server | undefined;

afterEach(
  () =>
    new Promise<void>((resolve) => {
      vi.restoreAllMocks();
      if (!server) {
        resolve();
        return;
      }
      const activeServer = server;
      server = undefined;
      activeServer.close(() => resolve());
      activeServer.closeAllConnections();
    }),
);

async function listen(app: ReturnType<typeof createApp>) {
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

async function startApp(fetcher: typeof fetch) {
  const client = new CursorApiClient(
    "test-key",
    "https://cursor.test",
    fetcher,
  );
  const app = createApp({ client, loadTeamMetadata: false });
  return listen(app);
}

function rawRequestStatus(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

const emptyMcpResponse: McpResponse = {
  records: [],
  summary: {
    totalUsage: 0,
    uniqueUsers: 0,
    uniqueServers: 0,
    uniqueTools: 0,
  },
  range: { startDate: "2026-09-01", endDate: "2026-09-18" },
  generatedAt: "2026-09-18T00:00:00.000Z",
  source: "live",
};

const teamMetadata: TeamMetadata = {
  users: new Map(),
  memberCount: 10,
  groupNames: ["Engineering"],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("server hardening", () => {
  it("marks every API response private and non-cacheable", async () => {
    const baseUrl = await listen(createApp({}));

    for (const path of ["/api/health", "/api/mcp"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("sets browser security headers on every response", async () => {
    const baseUrl = await listen(createApp({}));
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get("cross-origin-opener-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=()",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("keeps liveness independent from readiness", async () => {
    const baseUrl = await listen(createApp({}));

    const health = await fetch(`${baseUrl}/api/health`);
    const ready = await fetch(`${baseUrl}/api/ready`);
    const healthReady = await fetch(`${baseUrl}/api/health/ready`);

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, configured: false });
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ok: false, configured: false });
    expect(healthReady.status).toBe(503);
  });

  it("returns a consistent JSON 404 for unknown API routes", async () => {
    const baseUrl = await listen(createApp({}));

    const responses = await Promise.all([
      fetch(`${baseUrl}/api/not-a-route`),
      fetch(`${baseUrl}/api/mcp/not-a-route`),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "API route not found." });
    }
  });

  it("serves the SPA shell for client-side routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-dashboard-static-"));
    try {
      await writeFile(
        join(directory, "index.html"),
        '<!doctype html><div id="root"></div>',
      );
      const baseUrl = await listen(createApp({ staticDir: directory }));

      const response = await fetch(`${baseUrl}/reporting/user-1`);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<div id="root"></div>');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports ready when a client is configured", async () => {
    const baseUrl = await listen(
      createApp({ client: new CursorApiClient("test-key") }),
    );

    const response = await fetch(`${baseUrl}/api/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, configured: true });
  });

  it("bounds concurrent analytics work", async () => {
    const client = new CursorApiClient("test-key");
    const pendingAnalytics = deferred<McpResponse>();
    const fetchMcp = vi
      .spyOn(client, "fetchMcp")
      .mockImplementation(() => pendingAnalytics.promise);
    const baseUrl = await listen(
      createApp({
        client,
        loadTeamMetadata: false,
        maxConcurrentAnalytics: 1,
      }),
    );

    const firstRequest = fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-01`,
    );
    await vi.waitFor(() => expect(fetchMcp).toHaveBeenCalledOnce());

    const rejected = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-02&endDate=2026-09-02`,
    );

    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect(await rejected.json()).toEqual({
      error: "Too many analytics requests are already in progress.",
    });

    pendingAnalytics.resolve(structuredClone(emptyMcpResponse));
    expect((await firstRequest).status).toBe(200);
  });

  it("stays unready while a saved key is being validated", async () => {
    const client = new CursorApiClient("test-key");
    const validation = deferred<{
      status: "valid";
      metadata: TeamMetadata;
    }>();
    const baseUrl = await listen(
      createApp({
        client,
        initialClientValidation: validation.promise,
      }),
    );

    expect((await fetch(`${baseUrl}/api/ready`)).status).toBe(503);
    validation.resolve({ status: "valid", metadata: teamMetadata });

    await vi.waitFor(async () => {
      expect((await fetch(`${baseUrl}/api/ready`)).status).toBe(200);
    });
  });

  it("rejects DNS-rebinding and cross-site browser requests on loopback", async () => {
    const baseUrl = await listen(createApp({ loopbackOnly: true }));

    const reboundStatus = await rawRequestStatus(`${baseUrl}/api/health`, {
      Host: "attacker.example",
    });
    const crossSite = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: "https://attacker.example" },
    });
    const fetchMetadata = await fetch(`${baseUrl}/api/health`, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    const localDev = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(reboundStatus).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(fetchMetadata.status).toBe(403);
    expect(localDev.status).toBe(200);
  });
});

describe("MCP API endpoint", () => {
  it("returns normalized Cursor analytics", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            "alex@example.com": [
              {
                event_date: "2026-09-18",
                mcp_server_name: "github",
                tool_name: "search",
                usage: 9,
              },
            ],
          },
          pagination: { totalPages: 1, hasNextPage: false },
        }),
        { status: 200 },
      ),
    );
    const baseUrl = await startApp(fetcher);

    const response = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary.totalUsage).toBe(9);
    expect(body.records[0].server).toBe("github");
  });

  it("rejects malformed date parameters before calling Cursor", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const baseUrl = await startApp(fetcher);

    const response = await fetch(
      `${baseUrl}/api/mcp?startDate=bad&endDate=2026-09-18`,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("YYYY-MM-DD");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bypasses the range cache when refresh is requested", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: {},
            pagination: { totalPages: 1, hasNextPage: false },
          }),
          { status: 200 },
        ),
    );
    const baseUrl = await startApp(fetcher);
    const range = "startDate=2026-09-01&endDate=2026-09-18";

    await fetch(`${baseUrl}/api/mcp?${range}`);
    await fetch(`${baseUrl}/api/mcp?${range}`);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await fetch(`${baseUrl}/api/mcp?${range}&refresh=1`);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rate limits repeated refreshes of a settled range", async () => {
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchMcp").mockResolvedValue(
      structuredClone(emptyMcpResponse),
    );
    const baseUrl = await listen(
      createApp({ client, loadTeamMetadata: false }),
    );
    const range = "startDate=2026-09-01&endDate=2026-09-18";

    expect((await fetch(`${baseUrl}/api/mcp?${range}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/mcp?${range}&refresh=1`)).status).toBe(
      200,
    );

    const throttled = await fetch(`${baseUrl}/api/mcp?${range}&refresh=1`);

    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({
      error: "This date range was refreshed recently. Try again shortly.",
    });
  });

  it("shares in-flight metadata across concurrent range refreshes", async () => {
    const client = new CursorApiClient("test-key");
    const fetchMcp = vi
      .spyOn(client, "fetchMcp")
      .mockImplementation(async (startDate, endDate) => ({
        ...structuredClone(emptyMcpResponse),
        range: { startDate, endDate },
      }));
    const refreshMetadata = deferred<TeamMetadata>();
    let metadataCall = 0;
    let refreshSignal: AbortSignal | undefined;
    const fetchTeamMetadata = vi
      .spyOn(client, "fetchTeamMetadata")
      .mockImplementation(async (signal) => {
        metadataCall += 1;
        if (metadataCall !== 2) return teamMetadata;
        refreshSignal = signal;
        return refreshMetadata.promise;
      });
    const baseUrl = await listen(createApp({ client }));
    const firstRange = "startDate=2026-09-01&endDate=2026-09-01";
    const secondRange = "startDate=2026-09-02&endDate=2026-09-02";

    expect((await fetch(`${baseUrl}/api/mcp?${firstRange}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/mcp?${secondRange}`)).status).toBe(200);

    const firstRefresh = fetch(`${baseUrl}/api/mcp?${firstRange}&refresh=1`);
    await vi.waitFor(() => expect(fetchTeamMetadata).toHaveBeenCalledTimes(2));
    const secondRefresh = fetch(`${baseUrl}/api/mcp?${secondRange}&refresh=1`);
    await vi.waitFor(() => expect(fetchMcp).toHaveBeenCalledTimes(4));
    const metadataRequestWasAborted = refreshSignal?.aborted;
    const metadataRequestCount = fetchTeamMetadata.mock.calls.length;
    refreshMetadata.resolve(teamMetadata);
    const [firstResponse, secondResponse] = await Promise.all([
      firstRefresh,
      secondRefresh,
    ]);

    expect(metadataRequestWasAborted).toBe(false);
    expect(metadataRequestCount).toBe(2);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
  });

  it("does not let older analytics overwrite refreshed metadata", async () => {
    const email = "user@example.test";
    const metadata = (name: string): TeamMetadata => ({
      users: new Map([
        [
          email,
          {
            name,
            role: "member",
            directoryGroups: ["Engineering"],
          },
        ],
      ]),
      memberCount: 1,
      groupNames: ["Engineering"],
    });
    const responseFor = (startDate: string, endDate: string): McpResponse => ({
      records: [
        {
          date: startDate,
          userId: "user-1",
          email,
          displayName: email,
          server: "github",
          tool: "search",
          usage: 1,
        },
      ],
      summary: {
        totalUsage: 1,
        uniqueUsers: 1,
        uniqueServers: 1,
        uniqueTools: 1,
      },
      range: { startDate, endDate },
      generatedAt: "2026-09-18T00:00:00.000Z",
      source: "live",
    });
    const delayedAnalytics = deferred<McpResponse>();
    const client = new CursorApiClient("test-key");
    const fetchMcp = vi
      .spyOn(client, "fetchMcp")
      .mockImplementation(async (startDate, endDate) =>
        startDate === "2026-09-02"
          ? delayedAnalytics.promise
          : responseFor(startDate, endDate),
      );
    const fetchTeamMetadata = vi
      .spyOn(client, "fetchTeamMetadata")
      .mockResolvedValueOnce(metadata("Old name"))
      .mockResolvedValueOnce(metadata("Fresh name"));
    const baseUrl = await listen(createApp({ client }));
    const firstRange = "startDate=2026-09-01&endDate=2026-09-01";
    const delayedRange = "startDate=2026-09-02&endDate=2026-09-02";
    const laterRange = "startDate=2026-09-03&endDate=2026-09-03";

    expect((await fetch(`${baseUrl}/api/mcp?${firstRange}`)).status).toBe(200);
    const delayedRequest = fetch(`${baseUrl}/api/mcp?${delayedRange}`);
    await vi.waitFor(() => expect(fetchMcp).toHaveBeenCalledTimes(2));

    const refreshed = await fetch(`${baseUrl}/api/mcp?${firstRange}&refresh=1`);
    expect((await refreshed.json()).records[0].displayName).toBe("Fresh name");

    delayedAnalytics.resolve(responseFor("2026-09-02", "2026-09-02"));
    expect((await delayedRequest).status).toBe(200);

    const later = await fetch(`${baseUrl}/api/mcp?${laterRange}`);
    expect((await later.json()).records[0].displayName).toBe("Fresh name");
    expect(fetchTeamMetadata).toHaveBeenCalledTimes(2);
  });

  it("refreshes analytics and team metadata after the cache TTL", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const client = new CursorApiClient("test-key");
    const fetchMcp = vi
      .spyOn(client, "fetchMcp")
      .mockResolvedValue(structuredClone(emptyMcpResponse));
    const fetchTeamMetadata = vi
      .spyOn(client, "fetchTeamMetadata")
      .mockResolvedValue(teamMetadata);
    const baseUrl = await listen(createApp({ client, cacheTtlMs: 10 }));
    const range = "startDate=2026-09-01&endDate=2026-09-18";

    await fetch(`${baseUrl}/api/mcp?${range}`);
    await fetch(`${baseUrl}/api/mcp?${range}`);
    expect(fetchMcp).toHaveBeenCalledTimes(1);
    expect(fetchTeamMetadata).toHaveBeenCalledTimes(1);

    now += 11;
    await fetch(`${baseUrl}/api/mcp?${range}`);
    expect(fetchMcp).toHaveBeenCalledTimes(2);
    expect(fetchTeamMetadata).toHaveBeenCalledTimes(2);
  });

  it("uses a twelve-hour default cache TTL", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const client = new CursorApiClient("test-key");
    const fetchMcp = vi
      .spyOn(client, "fetchMcp")
      .mockResolvedValue(structuredClone(emptyMcpResponse));
    const baseUrl = await listen(
      createApp({ client, loadTeamMetadata: false }),
    );
    const range = "startDate=2026-09-01&endDate=2026-09-18";
    const twelveHours = 12 * 60 * 60_000;

    await fetch(`${baseUrl}/api/mcp?${range}`);
    now += twelveHours - 1;
    await fetch(`${baseUrl}/api/mcp?${range}`);
    expect(fetchMcp).toHaveBeenCalledOnce();

    now += 2;
    await fetch(`${baseUrl}/api/mcp?${range}`);
    expect(fetchMcp).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest analytics range when the cache is full", async () => {
    const client = new CursorApiClient("test-key");
    const fetchMcp = vi
      .spyOn(client, "fetchMcp")
      .mockImplementation(async (startDate, endDate) => ({
        ...structuredClone(emptyMcpResponse),
        range: { startDate, endDate },
      }));
    const baseUrl = await listen(
      createApp({
        client,
        loadTeamMetadata: false,
        cacheMaxEntries: 2,
      }),
    );
    const ranges = [
      "startDate=2026-09-01&endDate=2026-09-01",
      "startDate=2026-09-02&endDate=2026-09-02",
      "startDate=2026-09-03&endDate=2026-09-03",
    ];

    for (const range of ranges) await fetch(`${baseUrl}/api/mcp?${range}`);
    await fetch(`${baseUrl}/api/mcp?${ranges[0]}`);

    expect(fetchMcp).toHaveBeenCalledTimes(4);
  });

  it("bounds cached analytics by aggregate record count", async () => {
    const client = new CursorApiClient("test-key");
    const fetchMcp = vi
      .spyOn(client, "fetchMcp")
      .mockImplementation(async (startDate, endDate) => ({
        ...structuredClone(emptyMcpResponse),
        records: [
          {
            date: startDate,
            userId: "user-1",
            email: "user@example.com",
            displayName: "Example User",
            server: "github",
            tool: "search",
            usage: 1,
          },
        ],
        summary: {
          totalUsage: 1,
          uniqueUsers: 1,
          uniqueServers: 1,
          uniqueTools: 1,
        },
        range: { startDate, endDate },
      }));
    const baseUrl = await listen(
      createApp({
        client,
        loadTeamMetadata: false,
        cacheMaxRecords: 1,
      }),
    );
    const first = "startDate=2026-09-01&endDate=2026-09-01";
    const second = "startDate=2026-09-02&endDate=2026-09-02";

    await fetch(`${baseUrl}/api/mcp?${first}`);
    await fetch(`${baseUrl}/api/mcp?${second}`);
    await fetch(`${baseUrl}/api/mcp?${first}`);

    expect(fetchMcp).toHaveBeenCalledTimes(3);
  });

  it("fails closed when required team metadata is unavailable", async () => {
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchMcp").mockResolvedValue(
      structuredClone(emptyMcpResponse),
    );
    vi.spyOn(client, "fetchTeamMetadata").mockRejectedValue(
      new CursorApiError("metadata unavailable", 503),
    );
    const baseUrl = await listen(createApp({ client }));

    const response = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("Could not load data from Cursor.");
  });

  it("aborts analytics when the sibling metadata request fails", async () => {
    const client = new CursorApiClient("test-key");
    const signalSeen = deferred<AbortSignal>();
    vi.spyOn(client, "fetchMcp").mockImplementation(
      async (_startDate, _endDate, _memberNames, _onProgress, signal) =>
        new Promise<McpResponse>((_resolve, reject) => {
          if (!signal) throw new Error("Expected an abort signal");
          signalSeen.resolve(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    vi.spyOn(client, "fetchTeamMetadata").mockRejectedValue(
      new CursorApiError("metadata unavailable", 503),
    );
    const baseUrl = await listen(createApp({ client }));

    const response = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );

    expect(response.status).toBe(502);
    expect((await signalSeen.promise).aborted).toBe(true);
  });

  it("returns a dependency timeout when analytics exceeds its deadline", async () => {
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchMcp").mockImplementation(
      async (_startDate, _endDate, _memberNames, _onProgress, signal) =>
        new Promise<McpResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const baseUrl = await listen(
      createApp({
        client,
        loadTeamMetadata: false,
        analyticsTimeoutMs: 10,
      }),
    );

    const response = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: "Cursor API request timed out.",
    });
  });

  it("does not expose upstream response details", async () => {
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchMcp").mockRejectedValue(
      new CursorApiError(
        "Cursor API returned 503: internal-account-secret",
        503,
      ),
    );
    const baseUrl = await listen(
      createApp({ client, loadTeamMetadata: false }),
    );

    const response = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("Could not load data from Cursor.");
    expect(JSON.stringify(body)).not.toContain("internal-account-secret");
  });

  it("streams exact initial-load progress before dashboard data", async () => {
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchMcp").mockImplementation(
      async (_startDate, _endDate, _memberNames, onProgress) => {
        onProgress?.({ completedWindows: 0, totalWindows: 3 });
        onProgress?.({ completedWindows: 1, totalWindows: 3 });
        onProgress?.({ completedWindows: 2, totalWindows: 3 });
        onProgress?.({ completedWindows: 3, totalWindows: 3 });
        return structuredClone(emptyMcpResponse);
      },
    );
    const baseUrl = await listen(
      createApp({ client, loadTeamMetadata: false }),
    );

    const response = await fetch(
      `${baseUrl}/api/mcp/stream?startDate=2026-09-01&endDate=2026-09-18`,
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            completed?: number;
            total?: number;
          },
      );

    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(
      events
        .filter((event) => event.type === "progress")
        .map((event) => [event.completed, event.total]),
    ).toEqual([
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
    expect(events.at(-1)?.type).toBe("data");
  });

  it("streams directory-group enrichment progress after analytics completes", async () => {
    const client = new CursorApiClient("test-key");
    const metadataResult = deferred<TeamMetadata>();
    let reportMetadata:
      | ((progress: { completedGroups: number; totalGroups?: number }) => void)
      | undefined;
    vi.spyOn(client, "fetchMcp").mockImplementation(
      async (_startDate, _endDate, _memberNames, onProgress) => {
        onProgress?.({ completedWindows: 3, totalWindows: 3 });
        return structuredClone(emptyMcpResponse);
      },
    );
    vi.spyOn(client, "fetchTeamMetadata").mockImplementation(
      async (_signal, onProgress) => {
        reportMetadata = onProgress;
        return metadataResult.promise;
      },
    );
    const baseUrl = await listen(createApp({ client }));
    const response = await fetch(
      `${baseUrl}/api/mcp/stream?startDate=2026-09-01&endDate=2026-09-18`,
    );
    await vi.waitFor(() => expect(reportMetadata).toBeTypeOf("function"));

    reportMetadata?.({ completedGroups: 0, totalGroups: 2 });
    reportMetadata?.({ completedGroups: 1, totalGroups: 2 });
    metadataResult.resolve(teamMetadata);

    const events = (await response.text())
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            completed?: number;
            total?: number;
            label?: string;
            detail?: string;
          },
      );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        completed: 3.5,
        total: 5,
        label: "Team metadata",
        detail: "1 / 2 directory groups",
      }),
    );
    expect(events.at(-1)?.type).toBe("data");
  });

  it("reuses team metadata validated during startup", async () => {
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchMcp").mockResolvedValue(
      structuredClone(emptyMcpResponse),
    );
    const fetchTeamMetadata = vi.spyOn(client, "fetchTeamMetadata");
    const baseUrl = await listen(
      createApp({ client, initialTeamMetadata: teamMetadata }),
    );

    const response = await fetch(
      `${baseUrl}/api/mcp/stream?startDate=2026-09-01&endDate=2026-09-18`,
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(fetchTeamMetadata).not.toHaveBeenCalled();
  });

  it("aborts Cursor work when a stream client disconnects", async () => {
    const client = new CursorApiClient("test-key");
    const signalSeen = deferred<AbortSignal>();
    vi.spyOn(client, "fetchMcp").mockImplementation(
      async (_startDate, _endDate, _memberNames, _onProgress, signal) =>
        new Promise<McpResponse>((_resolve, reject) => {
          if (!signal) throw new Error("Expected an abort signal");
          signalSeen.resolve(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const baseUrl = await listen(
      createApp({ client, loadTeamMetadata: false }),
    );
    const controller = new AbortController();

    const response = await fetch(
      `${baseUrl}/api/mcp/stream?startDate=2026-09-01&endDate=2026-09-18`,
      { signal: controller.signal },
    );
    const upstreamSignal = await signalSeen.promise;
    controller.abort();

    await vi.waitFor(() => expect(upstreamSignal.aborted).toBe(true));
    await expect(response.text()).rejects.toThrow();
  });

  it("reuses a cached range for subsequent stream requests", async () => {
    const client = new CursorApiClient("test-key");
    const fetchMcp = vi
      .spyOn(client, "fetchMcp")
      .mockResolvedValue(structuredClone(emptyMcpResponse));
    const baseUrl = await listen(
      createApp({ client, loadTeamMetadata: false }),
    );
    const url = `${baseUrl}/api/mcp/stream?startDate=2026-09-01&endDate=2026-09-18`;

    await (await fetch(url)).text();
    await (await fetch(url)).text();

    expect(fetchMcp).toHaveBeenCalledOnce();
  });

  it("aborts ordinary Cursor work when its only client disconnects", async () => {
    const client = new CursorApiClient("test-key");
    const signalSeen = deferred<AbortSignal>();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchMcp = vi.spyOn(client, "fetchMcp").mockImplementation(
      async (_startDate, _endDate, _memberNames, _onProgress, signal) =>
        new Promise<McpResponse>((_resolve, reject) => {
          if (!signal) throw new Error("Expected an abort signal");
          signalSeen.resolve(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const baseUrl = await listen(
      createApp({ client, loadTeamMetadata: false }),
    );
    const request = httpRequest(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    request.on("error", () => undefined);
    request.end();
    const upstreamSignal = await signalSeen.promise;

    request.destroy();

    await vi.waitFor(() => expect(upstreamSignal.aborted).toBe(true));
    fetchMcp.mockResolvedValueOnce(structuredClone(emptyMcpResponse));
    const retry = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    expect(retry.status).toBe(200);
    expect(fetchMcp).toHaveBeenCalledTimes(2);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not abort an active subscriber when its cache TTL elapses", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const client = new CursorApiClient("test-key");
    const signals: AbortSignal[] = [];
    vi.spyOn(client, "fetchMcp").mockImplementation(
      async (_startDate, _endDate, _memberNames, _onProgress, signal) =>
        new Promise<McpResponse>((_resolve, reject) => {
          if (!signal) throw new Error("Expected an abort signal");
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const baseUrl = await listen(
      createApp({
        client,
        loadTeamMetadata: false,
        cacheTtlMs: 10,
      }),
    );
    const first = httpRequest(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-01`,
    );
    first.on("error", () => undefined);
    first.end();
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    now += 11;
    const second = httpRequest(
      `${baseUrl}/api/mcp?startDate=2026-09-02&endDate=2026-09-02`,
    );
    second.on("error", () => undefined);
    second.end();
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    expect(signals[0].aborted).toBe(false);
    first.destroy();
    second.destroy();
    await vi.waitFor(() =>
      expect(signals.every((signal) => signal.aborted)).toBe(true),
    );
  });

  it("continues coalescing an active range after its cache TTL elapses", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const client = new CursorApiClient("test-key");
    const result = deferred<McpResponse>();
    const fetchMcp = vi
      .spyOn(client, "fetchMcp")
      .mockReturnValue(result.promise);
    const baseUrl = await listen(
      createApp({
        client,
        loadTeamMetadata: false,
        cacheTtlMs: 10,
      }),
    );
    const url = `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-01`;

    const first = fetch(url);
    await vi.waitFor(() => expect(fetchMcp).toHaveBeenCalledOnce());
    now += 11;
    const second = fetch(url);
    result.resolve(structuredClone(emptyMcpResponse));

    const responses = await Promise.all([first, second]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(fetchMcp).toHaveBeenCalledOnce();
  });

  it("maps upstream request rejection to a dependency failure", async () => {
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchMcp").mockRejectedValue(
      new CursorApiError("Cursor API returned 400", 400),
    );
    const baseUrl = await listen(
      createApp({ client, loadTeamMetadata: false }),
    );

    const response = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Cursor API rejected the request.",
    });
  });
});

describe("dashboard setup endpoint", () => {
  it("rejects malformed and oversized JSON without logging key material", async () => {
    const secret = "key_do_not_log";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const configure = vi.fn();
    const setupUrl = await listen(
      createApp({ setup: { allowed: true, configure } }),
    );

    const malformed = await fetch(`${setupUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"apiKey":"${secret}"`,
    });
    const oversizedSecret = `${secret}${"x".repeat(5_000)}`;
    const oversizedSetup = await fetch(`${setupUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: oversizedSecret }),
    });

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Malformed JSON request body.",
    });
    expect(oversizedSetup.status).toBe(413);
    expect(configure).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const settingsUrl = await listen(
      createApp({
        client: new CursorApiClient("current"),
        setup: { allowed: true, configure },
      }),
    );
    const malformedSettings = await fetch(
      `${settingsUrl}/api/settings/api-key`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `{"apiKey":"${secret}"`,
      },
    );
    const oversized = await fetch(`${settingsUrl}/api/settings/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: oversizedSecret }),
    });

    expect(malformedSettings.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: "Request body is too large.",
    });
    expect(configure).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
  });

  it("logs unexpected setup failures without error details", async () => {
    const secret = "synthetic-sensitive-detail";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const baseUrl = await listen(
      createApp({
        setup: {
          allowed: true,
          configure: vi
            .fn()
            .mockRejectedValue(new Error(`validation failed for ${secret}`)),
        },
      }),
    );

    const response = await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: secret }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Unexpected server error",
    });
    expect(consoleError).toHaveBeenCalledOnce();
    const logged = String(consoleError.mock.calls[0][0]);
    expect(logged).toContain("request.unexpected_error");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("validation failed");
  });

  it("reports setup mode and configures the dashboard once", async () => {
    const configuredClient = new CursorApiClient("new-key");
    vi.spyOn(configuredClient, "fetchMcp").mockResolvedValue(
      structuredClone(emptyMcpResponse),
    );
    const configure = vi.fn().mockResolvedValue(configuredClient);
    const baseUrl = await listen(
      createApp({
        setup: { allowed: true, configure },
        loadTeamMetadata: false,
      }),
    );

    const initialStatus = await fetch(`${baseUrl}/api/setup/status`);
    expect(await initialStatus.json()).toEqual({
      configured: false,
      setupAllowed: true,
    });

    const blockedAnalytics = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    expect(blockedAnalytics.status).toBe(428);
    expect(await blockedAnalytics.json()).toMatchObject({
      code: "SETUP_REQUIRED",
    });

    const setupResponse = await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "key_new" }),
    });
    expect(setupResponse.status).toBe(201);
    expect(configure).toHaveBeenCalledWith("key_new", expect.any(AbortSignal));

    const configuredStatus = await fetch(`${baseUrl}/api/setup/status`);
    expect(await configuredStatus.json()).toEqual({
      configured: true,
      setupAllowed: true,
    });

    const analytics = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    expect(analytics.status).toBe(200);
  });

  it("returns a conflict for a superseded concurrent setup request", async () => {
    const firstResult = deferred<CursorApiClient>();
    const secondResult = deferred<CursorApiClient>();
    const firstClient = new CursorApiClient("first");
    const secondClient = new CursorApiClient("second");
    const configure = vi.fn((key: string, _signal?: AbortSignal) =>
      key === "first" ? firstResult.promise : secondResult.promise,
    );
    const persist = vi.fn(async () => undefined);
    const baseUrl = await listen(
      createApp({
        setup: { allowed: true, configure, persist },
        loadTeamMetadata: false,
      }),
    );
    const setup = (apiKey: string) =>
      fetch(`${baseUrl}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

    const firstSetup = setup("first");
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    const secondSetup = setup("second");
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
    expect(configure.mock.calls[0][1]?.aborted).toBe(true);
    secondResult.resolve(secondClient);
    const winningResponse = await secondSetup;
    firstResult.resolve(firstClient);
    const supersededResponse = await firstSetup;

    expect(winningResponse.status).toBe(201);
    expect(await winningResponse.json()).toEqual({ configured: true });
    expect(supersededResponse.status).toBe(409);
    expect(await supersededResponse.json()).toEqual({
      error: "A newer API key update was submitted. Retry if needed.",
      code: "CONFIGURATION_SUPERSEDED",
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("second");
  });

  it("rejects browser setup when the server is exposed", async () => {
    const configure = vi.fn();
    const baseUrl = await listen(
      createApp({ setup: { allowed: false, configure } }),
    );

    const response = await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "key_new" }),
    });

    expect(response.status).toBe(403);
    expect(configure).not.toHaveBeenCalled();
  });

  it("rotates a configured key without exposing the existing key", async () => {
    const currentClient = new CursorApiClient("current-key");
    const replacementClient = new CursorApiClient("replacement-key");
    const configure = vi.fn().mockResolvedValue(replacementClient);
    const baseUrl = await listen(
      createApp({
        client: currentClient,
        setup: { allowed: true, configure },
      }),
    );

    const response = await fetch(`${baseUrl}/api/settings/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "key_replacement" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true });
    expect(configure).toHaveBeenCalledWith(
      "key_replacement",
      expect.any(AbortSignal),
    );
  });

  it("returns a conflict and does not persist a superseded rotation", async () => {
    const firstResult = deferred<CursorApiClient>();
    const secondResult = deferred<CursorApiClient>();
    const firstClient = new CursorApiClient("first");
    const secondClient = new CursorApiClient("second");
    const firstFetch = vi
      .spyOn(firstClient, "fetchMcp")
      .mockResolvedValue(structuredClone(emptyMcpResponse));
    const secondFetch = vi
      .spyOn(secondClient, "fetchMcp")
      .mockResolvedValue(structuredClone(emptyMcpResponse));
    const configure = vi.fn((key: string) =>
      key === "first" ? firstResult.promise : secondResult.promise,
    );
    const persist = vi.fn(async () => undefined);
    const baseUrl = await listen(
      createApp({
        client: new CursorApiClient("current"),
        setup: { allowed: true, configure, persist },
        loadTeamMetadata: false,
      }),
    );
    const rotate = (apiKey: string) =>
      fetch(`${baseUrl}/api/settings/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

    const firstRotation = rotate("first");
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    const secondRotation = rotate("second");
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
    secondResult.resolve(secondClient);
    const winningResponse = await secondRotation;
    firstResult.resolve(firstClient);
    const supersededResponse = await firstRotation;

    expect(winningResponse.status).toBe(200);
    expect(await winningResponse.json()).toEqual({ configured: true });
    expect(supersededResponse.status).toBe(409);
    expect(await supersededResponse.json()).toEqual({
      error: "A newer API key update was submitted. Retry if needed.",
      code: "CONFIGURATION_SUPERSEDED",
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("second");

    const analytics = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    expect(analytics.status).toBe(200);
    expect(secondFetch).toHaveBeenCalledOnce();
    expect(firstFetch).not.toHaveBeenCalled();
  });

  it("keeps the current key when a newer concurrent rotation fails", async () => {
    const firstResult = deferred<CursorApiClient>();
    const secondResult = deferred<CursorApiClient>();
    const currentClient = new CursorApiClient("current");
    const firstClient = new CursorApiClient("first");
    const currentFetch = vi
      .spyOn(currentClient, "fetchMcp")
      .mockResolvedValue(structuredClone(emptyMcpResponse));
    const configure = vi.fn((key: string) =>
      key === "first" ? firstResult.promise : secondResult.promise,
    );
    const persist = vi.fn(async () => undefined);
    const baseUrl = await listen(
      createApp({
        client: currentClient,
        setup: { allowed: true, configure, persist },
        loadTeamMetadata: false,
      }),
    );
    const rotate = (apiKey: string) =>
      fetch(`${baseUrl}/api/settings/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

    const firstRotation = rotate("first");
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    const secondRotation = rotate("second");
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
    secondResult.reject(new CursorApiError("rejected", 401));
    const failedResponse = await secondRotation;
    firstResult.resolve(firstClient);
    const supersededResponse = await firstRotation;

    expect(failedResponse.status).toBe(401);
    expect(await failedResponse.json()).toEqual({
      error: "Cursor rejected the API key.",
    });
    expect(supersededResponse.status).toBe(409);
    expect(await supersededResponse.json()).toMatchObject({
      code: "CONFIGURATION_SUPERSEDED",
    });
    expect(persist).not.toHaveBeenCalled();

    const analytics = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    expect(analytics.status).toBe(200);
    expect(currentFetch).toHaveBeenCalledOnce();
  });

  it("ignores an unauthorized response from a superseded client", async () => {
    const oldRequest = deferred<McpResponse>();
    const currentClient = new CursorApiClient("current");
    const replacementClient = new CursorApiClient("replacement");
    const oldFetch = vi
      .spyOn(currentClient, "fetchMcp")
      .mockReturnValue(oldRequest.promise);
    const replacementFetch = vi
      .spyOn(replacementClient, "fetchMcp")
      .mockResolvedValue(structuredClone(emptyMcpResponse));
    const baseUrl = await listen(
      createApp({
        client: currentClient,
        setup: {
          allowed: true,
          configure: vi.fn().mockResolvedValue(replacementClient),
        },
        loadTeamMetadata: false,
      }),
    );

    const staleRequest = fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledOnce());
    const rotation = await fetch(`${baseUrl}/api/settings/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "replacement" }),
    });
    expect(rotation.status).toBe(200);
    oldRequest.reject(new CursorApiError("old credential detail", 401));
    expect((await staleRequest).status).toBe(401);

    const status = await fetch(`${baseUrl}/api/setup/status`);
    expect(await status.json()).toMatchObject({ configured: true });
    const analytics = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    expect(analytics.status).toBe(200);
    expect(replacementFetch).toHaveBeenCalledOnce();
  });

  it("rejects key rotation on a non-loopback deployment", async () => {
    const configure = vi.fn();
    const baseUrl = await listen(
      createApp({
        client: new CursorApiClient("current-key"),
        setup: { allowed: false, configure },
      }),
    );

    const response = await fetch(`${baseUrl}/api/settings/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "key_replacement" }),
    });

    expect(response.status).toBe(403);
    expect(configure).not.toHaveBeenCalled();
  });

  it("keeps the current client when a replacement key is rejected", async () => {
    const currentClient = new CursorApiClient("current-key");
    vi.spyOn(currentClient, "fetchMcp").mockResolvedValue(
      structuredClone(emptyMcpResponse),
    );
    const configure = vi
      .fn()
      .mockRejectedValue(new CursorApiError("Cursor API returned 401", 401));
    const baseUrl = await listen(
      createApp({
        client: currentClient,
        setup: { allowed: true, configure },
        loadTeamMetadata: false,
      }),
    );

    const rotation = await fetch(`${baseUrl}/api/settings/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "bad-key" }),
    });
    expect(rotation.status).toBe(401);

    const status = await fetch(`${baseUrl}/api/setup/status`);
    expect(await status.json()).toMatchObject({ configured: true });

    const analytics = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    expect(analytics.status).toBe(200);
  });

  it("returns to setup mode when the saved key is rejected", async () => {
    const client = new CursorApiClient("expired-key");
    vi.spyOn(client, "fetchMcp").mockRejectedValue(
      new CursorApiError("Cursor API returned 401", 401),
    );
    const baseUrl = await listen(
      createApp({ client, loadTeamMetadata: false }),
    );

    const response = await fetch(
      `${baseUrl}/api/mcp?startDate=2026-09-01&endDate=2026-09-18`,
    );
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      code: "SETUP_REQUIRED",
    });

    const status = await fetch(`${baseUrl}/api/setup/status`);
    expect(await status.json()).toMatchObject({ configured: false });
  });
});
