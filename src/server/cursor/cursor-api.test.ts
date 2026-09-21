import { describe, expect, it, vi } from "vitest";
import {
  CursorApiClient,
  enrichMcpResponse,
  retryDelayMilliseconds,
  type TeamMetadata,
} from "./cursor-api";
import type { McpResponse } from "../../contracts/mcp-response";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("CursorApiClient", () => {
  it("paginates and normalizes MCP records", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            "Alice@Example.com": [
              {
                event_date: "2026-09-01",
                tool_name: "search",
                mcp_server_name: "github",
                usage: 12,
              },
              {
                event_date: "2026-09-01",
                tool_name: "ignored",
                mcp_server_name: "github",
                usage: 0,
              },
            ],
          },
          pagination: { totalPages: 2, hasNextPage: true },
          params: {
            userMappings: [{ email: "alice@example.com", id: "user_1" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            "bob@example.com": [
              {
                event_date: "2026-09-02",
                tool_name: null,
                mcp_server_name: null,
                usage: 4,
              },
            ],
          },
          pagination: { totalPages: 2, hasNextPage: false },
          params: {
            userMappings: [{ email: "bob@example.com", id: "user_2" }],
          },
        }),
      );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    const result = await client.fetchMcp(
      "2026-09-01",
      "2026-09-10",
      new Map([["alice@example.com", "Alice Rivera"]]),
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0][0])).toContain("pageSize=500");
    expect(result.records).toEqual([
      {
        date: "2026-09-01",
        userId: "user_1",
        email: "alice@example.com",
        displayName: "Alice Rivera",
        server: "github",
        tool: "search",
        usage: 12,
        origin: "external",
      },
      {
        date: "2026-09-02",
        userId: "user_2",
        email: "bob@example.com",
        displayName: "bob",
        server: "Unnamed MCP",
        tool: "Unnamed tool",
        usage: 4,
        origin: "external",
      },
    ]);
    expect(result.summary).toEqual({
      totalUsage: 16,
      uniqueUsers: 2,
      uniqueServers: 2,
      uniqueTools: 2,
    });
  });

  it("retries rate limits and sends basic authentication", async () => {
    const sleep = vi.fn(async () => undefined);
    const retryResponse = jsonResponse({ error: "slow down" }, 429, {
      "retry-after": "0",
    });
    const cancelBody = vi.spyOn(retryResponse.body!, "cancel");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(retryResponse)
      .mockResolvedValueOnce(
        jsonResponse({
          data: {},
          pagination: { totalPages: 1, hasNextPage: false },
        }),
      );
    const client = new CursorApiClient(
      "secret-test",
      "https://example.test",
      fetcher,
      sleep,
    );

    await client.fetchMcp("2026-09-01", "2026-09-10");

    expect(sleep).toHaveBeenCalledOnce();
    expect(cancelBody).toHaveBeenCalledOnce();
    const headers = fetcher.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("secret-test:").toString("base64")}`,
    );
  });

  it("backs off when a retryable response omits Retry-After", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {},
          pagination: { totalPages: 1, hasNextPage: false },
        }),
      );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
      sleep,
    );

    await client.fetchMcp("2026-09-01", "2026-09-10");

    expect(sleep).toHaveBeenCalledWith(500, expect.any(AbortSignal));
  });

  it("supports HTTP-date Retry-After values", () => {
    expect(
      retryDelayMilliseconds(
        "Wed, 21 Oct 2015 07:28:00 GMT",
        500,
        Date.parse("2015-10-21T07:27:58.000Z"),
      ),
    ).toBe(2_000);
  });

  it("caps untrusted Retry-After delays", () => {
    expect(retryDelayMilliseconds("999999", 500)).toBe(120_000);
    expect(
      retryDelayMilliseconds(
        "Wed, 21 Oct 2037 07:28:00 GMT",
        500,
        Date.parse("2015-10-21T07:27:58.000Z"),
      ),
    ).toBe(120_000);
  });

  it("aborts while waiting to retry", async () => {
    const sleepStarted = deferred<void>();
    const sleep = vi.fn(
      async () =>
        new Promise<void>(() => {
          sleepStarted.resolve();
        }),
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: "slow down" }, 429, {
        "retry-after": "30",
      }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
      sleep,
    );
    const controller = new AbortController();
    const request = client.fetchMcp(
      "2026-09-01",
      "2026-09-10",
      new Map(),
      undefined,
      controller.signal,
    );
    await sleepStarted.promise;

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("loads directory group membership for team users", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/teams/members")) {
        return jsonResponse({
          teamMembers: [
            {
              id: "user_1",
              email: "alex@example.com",
              name: "Alex",
              role: "member",
              isRemoved: false,
            },
          ],
        });
      }
      if (url.includes("/teams/directory-groups/team_group_1/members")) {
        return jsonResponse({
          members: [{ userId: "user_1", email: "alex@example.com" }],
          pagination: { totalPages: 1, hasNextPage: false },
        });
      }
      return jsonResponse({
        groups: [{ id: "team_group_1", name: "Pilot Program" }],
        pagination: { totalPages: 1, hasNextPage: false },
      });
    });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    const metadata = await client.fetchTeamMetadata();

    expect(metadata.memberCount).toBe(1);
    expect(metadata.groupNames).toEqual(["Pilot Program"]);
    expect(metadata.users.get("alex@example.com")).toMatchObject({
      name: "Alex",
      role: "member",
      directoryGroups: ["Pilot Program"],
    });
  });

  it("accepts zero-page pagination for an empty directory group", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/teams/members") {
        return jsonResponse({ teamMembers: [] });
      }
      if (url.pathname.endsWith("/members")) {
        return jsonResponse({
          members: [],
          pagination: {
            totalCount: 0,
            totalPages: 0,
            hasNextPage: false,
          },
        });
      }
      return jsonResponse({
        groups: [{ id: "empty_group", name: "Empty group" }],
        pagination: {
          totalCount: 1,
          totalPages: 1,
          hasNextPage: false,
        },
      });
    });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );
    const progress: Array<{
      completedGroups: number;
      totalGroups?: number;
    }> = [];

    const metadata = await client.fetchTeamMetadata(undefined, (update) =>
      progress.push(update),
    );

    expect(metadata.groupNames).toEqual(["Empty group"]);
    expect(progress).toEqual([
      { completedGroups: 0 },
      { completedGroups: 0, totalGroups: 1 },
      { completedGroups: 1, totalGroups: 1 },
    ]);
  });

  it("gives hasNextPage precedence for directory groups and members", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/teams/members") {
        return jsonResponse({
          teamMembers: [
            {
              id: "user_1",
              email: "alex@example.com",
              name: "Alex",
              isRemoved: false,
            },
          ],
        });
      }
      if (url.pathname === "/teams/directory-groups") {
        const page = url.searchParams.get("page");
        return page === "1"
          ? jsonResponse({
              groups: [{ id: "group_1", name: "First" }],
              pagination: { totalPages: 1, hasNextPage: true },
            })
          : jsonResponse({
              groups: [{ id: "group_2", name: "Second" }],
              pagination: { totalPages: 1, hasNextPage: false },
            });
      }
      const page = url.searchParams.get("page");
      return page === "1"
        ? jsonResponse({
            members: [],
            pagination: { totalPages: 1, hasNextPage: true },
          })
        : jsonResponse({
            members: [{ userId: "user_1" }],
            pagination: { totalPages: 1, hasNextPage: false },
          });
    });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    const result = await client.fetchTeamMetadata();

    expect(result.groupNames).toEqual(["First", "Second"]);
    expect(result.users.get("alex@example.com")?.directoryGroups).toEqual([
      "First",
      "Second",
    ]);
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/teams/directory-groups?"),
      ),
    ).toHaveLength(2);
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/members?page=2"),
      ),
    ).toHaveLength(2);
  });

  it("stops directory pagination after repeated no-progress pages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/teams/members") return jsonResponse({});
      return jsonResponse({
        groups: [],
        pagination: { hasNextPage: true },
      });
    });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(client.fetchTeamMetadata()).rejects.toMatchObject({
      status: 502,
    });
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/teams/directory-groups?"),
      ),
    ).toHaveLength(3);
  });

  it("stops directory-member pagination after repeated no-progress pages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/teams/members") return jsonResponse({});
      if (url.pathname === "/teams/directory-groups") {
        return jsonResponse({
          groups: [{ id: "group_1", name: "Group" }],
          pagination: { hasNextPage: false },
        });
      }
      return jsonResponse({
        members: [],
        pagination: { hasNextPage: true },
      });
    });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(client.fetchTeamMetadata()).rejects.toMatchObject({
      status: 502,
    });
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/members?page="),
      ),
    ).toHaveLength(3);
  });

  it("splits ranges into API-compatible 30-day windows", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        data: {},
        pagination: { totalPages: 1, hasNextPage: false },
      }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );
    const onProgress = vi.fn();

    await client.fetchMcp("2026-06-21", "2026-09-18", new Map(), onProgress);

    expect(fetcher).toHaveBeenCalledTimes(3);
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain("startDate=2026-06-21&endDate=2026-07-20");
    expect(urls[1]).toContain("startDate=2026-07-21&endDate=2026-08-19");
    expect(urls[2]).toContain("startDate=2026-08-20&endDate=2026-09-18");
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { completedWindows: 0, totalWindows: 3 },
      { completedWindows: 1, totalWindows: 3 },
      { completedWindows: 2, totalWindows: 3 },
      { completedWindows: 3, totalWindows: 3 },
    ]);
  });

  it("limits concurrent date-window requests", async () => {
    let active = 0;
    let maxActive = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return jsonResponse({
        data: {},
        pagination: { totalPages: 1, hasNextPage: false },
      });
    });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await client.fetchMcp("2026-01-01", "2026-06-29");

    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(4);
  });

  it("aborts sibling windows and schedules no more after the first failure", async () => {
    const firstWaveStarted = deferred<void>();
    let started = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        started += 1;
        if (started === 4) firstWaveStarted.resolve();
        await firstWaveStarted.promise;

        const url = new URL(String(input));
        if (url.searchParams.get("startDate") === "2026-01-01") {
          return new Response("invalid upstream window", { status: 400 });
        }

        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(
      client.fetchMcp("2026-01-01", "2026-06-29"),
    ).rejects.toMatchObject({
      message: "Cursor API returned 400: invalid upstream window",
      status: 400,
    });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(
      fetcher.mock.calls
        .filter(([input]) => !String(input).includes("startDate=2026-01-01"))
        .every(([, init]) => init?.signal?.aborted),
    ).toBe(true);
  });

  it("honors hasNextPage when totalPages is omitted", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {},
          pagination: { hasNextPage: true },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {},
          pagination: { hasNextPage: false },
        }),
      );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await client.fetchMcp("2026-09-01", "2026-09-10");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain("page=2");
  });

  it("stops MCP pagination after repeated no-progress pages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        data: {},
        pagination: { hasNextPage: true },
      }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-10"),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("propagates caller aborts to in-flight Cursor requests", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );
    const controller = new AbortController();

    const request = client.fetchMcp(
      "2026-09-01",
      "2026-09-10",
      new Map(),
      undefined,
      controller.signal,
    );
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("propagates caller aborts to metadata requests", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );
    const controller = new AbortController();
    const request = client.fetchTeamMetadata(controller.signal);

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(
      true,
    );
  });

  it("rejects malformed metrics instead of silently undercounting", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          "alex@example.com": [
            {
              event_date: "2026-09-01",
              tool_name: "search",
              mcp_server_name: "github",
              usage: "not-a-number",
            },
          ],
        },
        pagination: { totalPages: 1, hasNextPage: false },
      }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-10"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("rejects malformed successful JSON responses as upstream failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{", { status: 200 }));
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-10"),
    ).rejects.toMatchObject({
      status: 502,
      message: "Cursor API returned malformed JSON",
    });
  });

  it("rejects oversized upstream responses before buffering them", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(11 * 1024 * 1024) },
      }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-10"),
    ).rejects.toMatchObject({
      status: 502,
      message: "Cursor API response exceeded the size limit",
    });
  });

  it("rejects incomplete successful analytics payloads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-10"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("rejects malformed nested team metadata as an upstream failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ teamMembers: [null] }))
      .mockResolvedValueOnce(jsonResponse({ groups: [] }));
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(client.fetchTeamMetadata()).rejects.toMatchObject({
      status: 502,
    });
  });

  it("enforces one record budget across concurrent date windows", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const date = url.searchParams.get("startDate");
      return jsonResponse({
        data: {
          "alex@example.com": [
            {
              event_date: date,
              tool_name: `tool-${date}`,
              mcp_server_name: "example",
              usage: 1,
            },
          ],
        },
        pagination: { hasNextPage: false },
      });
    });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
      undefined,
      "",
      2,
    );

    await expect(
      client.fetchMcp("2026-06-21", "2026-09-18"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("rejects analytics above the configured response byte limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          "alex@example.com": [
            {
              event_date: "2026-09-01",
              tool_name: "search",
              mcp_server_name: "github",
              usage: 1,
            },
          ],
        },
        pagination: { hasNextPage: false },
      }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
      undefined,
      "",
      undefined,
      { maxResponseBytes: 1 },
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-01"),
    ).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("response-size safety limit"),
    });
  });

  it("bounds directory groups and group memberships", async () => {
    const groupsFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          teamMembers: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          groups: [
            { id: "group-1", name: "One" },
            { id: "group-2", name: "Two" },
          ],
          pagination: { hasNextPage: false },
        }),
      );
    const groupsClient = new CursorApiClient(
      "test-key",
      "https://example.test",
      groupsFetcher,
      undefined,
      "",
      undefined,
      { maxDirectoryGroups: 1 },
    );

    await expect(groupsClient.fetchTeamMetadata()).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("directory groups"),
    });

    const membershipsFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          teamMembers: [
            {
              id: "user-1",
              email: "one@example.test",
              name: "One",
            },
            {
              id: "user-2",
              email: "two@example.test",
              name: "Two",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          groups: [{ id: "group-1", name: "Engineering" }],
          pagination: { hasNextPage: false },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          members: [{ userId: "user-1" }, { userId: "user-2" }],
          pagination: { hasNextPage: false },
        }),
      );
    const membershipsClient = new CursorApiClient(
      "test-key",
      "https://example.test",
      membershipsFetcher,
      undefined,
      "",
      undefined,
      { maxGroupMemberships: 1 },
    );

    await expect(membershipsClient.fetchTeamMetadata()).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("group memberships"),
    });
  });

  it("bounds group assignments added during enrichment", () => {
    const response: McpResponse = {
      records: [
        {
          date: "2026-09-01",
          userId: "user-1",
          email: "user@example.test",
          displayName: "User",
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
      range: {
        startDate: "2026-09-01",
        endDate: "2026-09-01",
      },
      generatedAt: "2026-09-01T12:00:00.000Z",
      source: "live",
    };
    const metadata: TeamMetadata = {
      users: new Map([
        [
          "user@example.test",
          {
            name: "User",
            role: "member",
            directoryGroups: ["One", "Two"],
          },
        ],
      ]),
      memberCount: 1,
      groupNames: ["One", "Two"],
    };

    expect(() => enrichMcpResponse(response, metadata, "", 1)).toThrow(
      "Enriched group assignments exceed the configured safety limit",
    );

    const enriched = enrichMcpResponse(response, metadata, "", 2);
    expect(enriched).not.toBe(response);
    expect(enriched.records[0]).toMatchObject({
      role: "member",
      directoryGroups: ["One", "Two"],
    });
    expect(response.records[0]).not.toHaveProperty("role");
  });

  it("continues pagination when valid pages contain only zero usage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return jsonResponse({
        data: {
          "alex@example.com": [
            {
              event_date: `2026-09-0${page}`,
              tool_name: `tool-${page}`,
              mcp_server_name: "example",
              usage: page === 4 ? 7 : 0,
            },
          ],
        },
        pagination: { hasNextPage: page < 4 },
      });
    });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    const result = await client.fetchMcp("2026-09-01", "2026-09-10");

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.summary.totalUsage).toBe(7);
  });

  it("counts zero-usage metrics against the processing budget", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          "alex@example.com": [
            {
              event_date: "2026-09-01",
              tool_name: "tool-1",
              mcp_server_name: "example",
              usage: 0,
            },
            {
              event_date: "2026-09-02",
              tool_name: "tool-2",
              mcp_server_name: "example",
              usage: 0,
            },
            {
              event_date: "2026-09-03",
              tool_name: "tool-3",
              mcp_server_name: "example",
              usage: 0,
            },
          ],
        },
        pagination: { hasNextPage: false },
      }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
      undefined,
      "",
      2,
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-10"),
    ).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("2-record safety limit"),
    });
  });

  it("allows zero-usage metrics exactly at the processing budget", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          "alex@example.com": [
            {
              event_date: "2026-09-01",
              tool_name: "tool-1",
              mcp_server_name: "example",
              usage: 0,
            },
            {
              event_date: "2026-09-02",
              tool_name: "tool-2",
              mcp_server_name: "example",
              usage: 0,
            },
          ],
        },
        pagination: { hasNextPage: false },
      }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
      undefined,
      "",
      2,
    );

    const result = await client.fetchMcp("2026-09-01", "2026-09-10");

    expect(result.records).toEqual([]);
  });

  it("shares the zero-usage processing budget across pages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return jsonResponse({
        data: {
          "alex@example.com": [
            {
              event_date: `2026-09-0${page}`,
              tool_name: `tool-${page}`,
              mcp_server_name: "example",
              usage: 0,
            },
          ],
        },
        pagination: { hasNextPage: page < 3 },
      });
    });
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
      undefined,
      "",
      2,
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-10"),
    ).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("2-record safety limit"),
    });
  });

  it("rejects duplicate aggregate rows instead of double-counting", async () => {
    const metric = {
      event_date: "2026-09-01",
      tool_name: "search",
      mcp_server_name: "github",
      usage: 3,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: { "alex@example.com": [metric, metric] },
        pagination: { totalPages: 1, hasNextPage: false },
      }),
    );
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-10"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("surfaces definitive authorization failures without retrying", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
    const client = new CursorApiClient(
      "test-key",
      "https://example.test",
      fetcher,
    );

    await expect(
      client.fetchMcp("2026-09-01", "2026-09-10"),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
