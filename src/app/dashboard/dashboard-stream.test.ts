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
});
