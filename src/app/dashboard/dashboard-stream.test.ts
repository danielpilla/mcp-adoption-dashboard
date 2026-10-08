import { afterEach, describe, expect, it } from "vitest";
import {
  DashboardSetupRequiredError,
  readDashboardStream,
} from "./dashboard-stream";
import { configureInternalMcpServers } from "../../contracts/mcp-origin";

const response = {
  records: [
    {
      date: "2026-09-20",
      userId: "user-1",
      email: "user@example.test",
      displayName: "Example User",
      server: "example",
      tool: "search",
      usage: 3,
      origin: "external",
    },
  ],
  summary: {
    totalUsage: 3,
    uniqueUsers: 1,
    uniqueServers: 1,
    uniqueTools: 1,
  },
  range: {
    startDate: "2026-09-20",
    endDate: "2026-09-20",
  },
  generatedAt: "2026-09-20T12:00:00.000Z",
  source: "live",
};

function byteStream(text: string, splitAt: number) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, splitAt));
      controller.enqueue(bytes.slice(splitAt));
      controller.close();
    },
  });
}

afterEach(() => {
  configureInternalMcpServers(undefined);
});

describe("dashboard stream reader", () => {
  it("parses progress and data across byte boundaries", async () => {
    const progress = {
      type: "progress",
      completed: 1,
      total: 2,
      label: "MCP activity",
      detail: "Loading café usage",
    };
    const body = `${JSON.stringify(progress)}\n${JSON.stringify({
      type: "data",
      data: response,
    })}\n`;
    const splitAt = new TextEncoder().encode(body).indexOf(0xc3) + 1;
    const observedProgress: unknown[] = [];

    const result = await readDashboardStream(
      byteStream(body, splitAt),
      (value) => observedProgress.push(value),
    );

    expect(observedProgress).toEqual([
      {
        completed: progress.completed,
        total: progress.total,
        label: progress.label,
        detail: progress.detail,
      },
    ]);
    expect(result).toEqual(response);
  });

  it("returns a typed setup-required error", async () => {
    const line = JSON.stringify({
      type: "error",
      code: "SETUP_REQUIRED",
      error: "Replace the saved key.",
    });

    await expect(
      readDashboardStream(byteStream(line, 5), () => undefined),
    ).rejects.toBeInstanceOf(DashboardSetupRequiredError);
  });

  it("rejects missing and incomplete streams", async () => {
    await expect(readDashboardStream(null, () => undefined)).rejects.toThrow(
      "did not provide a progress stream",
    );
    await expect(
      readDashboardStream(
        byteStream(
          JSON.stringify({
            type: "progress",
            completed: 1,
            total: 2,
            label: "Loading",
            detail: "Waiting",
          }),
          4,
        ),
        () => undefined,
      ),
    ).rejects.toThrow("did not finish loading");
  });

  it("rejects unknown event shapes", async () => {
    await expect(
      readDashboardStream(
        byteStream(JSON.stringify({ type: "unknown" }), 3),
        () => undefined,
      ),
    ).rejects.toThrow("invalid event");
  });

  it("assembles record batches into the final response", async () => {
    const { records, ...rest } = response;
    const body = [
      JSON.stringify({ type: "records", records }),
      JSON.stringify({ type: "records", records: [] }),
      JSON.stringify({ type: "data", data: rest }),
    ].join("\n");

    await expect(
      readDashboardStream(byteStream(body, 7), () => undefined),
    ).resolves.toEqual(response);
  });

  it("rejects record batches that do not match the summary", async () => {
    const body = [
      JSON.stringify({ type: "records", records: response.records }),
      JSON.stringify({ type: "records", records: response.records }),
      JSON.stringify({
        type: "data",
        data: { ...response, records: undefined },
      }),
    ].join("\n");

    await expect(
      readDashboardStream(byteStream(body, 7), () => undefined),
    ).rejects.toThrow();
  });

  it("reports directory progress with activity progress", async () => {
    const progress = {
      type: "progress",
      completed: 1,
      total: 2,
      label: "MCP activity",
      detail: "1 / 1 windows",
      directory: { status: "loading", completedGroups: 3, totalGroups: null },
    };
    const observed: unknown[] = [];
    const body = `${JSON.stringify(progress)}\n${JSON.stringify({
      type: "data",
      data: response,
    })}`;

    await readDashboardStream(byteStream(body, 3), (value) =>
      observed.push(value),
    );

    expect(observed).toEqual([
      {
        completed: 1,
        total: 2,
        label: "MCP activity",
        detail: "1 / 1 windows",
        directory: { status: "loading", completedGroups: 3, totalGroups: null },
      },
    ]);
  });

  it("reports day, record, window, and retry progress", async () => {
    const activity = {
      state: "loading",
      totalDays: 90,
      cachedDays: 60,
      fetchedDays: 40,
      records: 1200,
      completedWindows: 1,
      totalWindows: 2,
      windows: [
        {
          startDate: "2026-06-01",
          endDate: "2026-06-30",
          days: 30,
          pagesLoaded: 2,
          totalPages: null,
        },
      ],
      retry: {
        attempt: 2,
        maxAttempts: 5,
        delayMs: 1000,
        waitedMs: 200,
        reason: "network_error",
        status: null,
      },
      elapsedMs: 4000,
      idleMs: 250,
    };
    const observed: unknown[] = [];
    const body = [
      {
        type: "progress",
        completed: 1,
        total: 3,
        label: "MCP activity",
        detail: "1 / 2",
        activity,
      },
      { type: "data", data: response },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");

    await readDashboardStream(byteStream(body, 5), (value) =>
      observed.push(value),
    );

    expect(observed).toEqual([
      {
        completed: 1,
        total: 3,
        label: "MCP activity",
        detail: "1 / 2",
        // Fetched days never exceed the uncached days.
        activity: { ...activity, fetchedDays: 30 },
      },
    ]);
  });

  it.each([
    { state: "paused" },
    { records: -1 },
    { windows: "none" },
    { retry: { attempt: 2 } },
    { windows: [{ startDate: "June", endDate: "2026-06-30" }] },
  ])("drops malformed activity progress %j", async (override) => {
    const activity = {
      state: "loading",
      totalDays: 10,
      cachedDays: 0,
      fetchedDays: 0,
      records: 0,
      completedWindows: 0,
      totalWindows: 1,
      windows: [],
      retry: null,
      elapsedMs: 0,
      idleMs: 0,
      ...override,
    };
    const observed: unknown[] = [];
    const body = [
      {
        type: "progress",
        completed: 0,
        total: 2,
        label: "MCP activity",
        detail: "0 / 1",
        activity,
      },
      { type: "data", data: response },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");

    await readDashboardStream(byteStream(body, 5), (value) =>
      observed.push(value),
    );

    expect(observed).toEqual([
      { completed: 0, total: 2, label: "MCP activity", detail: "0 / 1" },
    ]);
  });
});
