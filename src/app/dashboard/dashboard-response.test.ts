import { afterEach, describe, expect, it } from "vitest";
import {
  classifyMcpServer,
  configureInternalMcpServers,
} from "../../contracts/mcp-origin";
import { ingestDashboardResponse } from "./dashboard-response";

afterEach(() => {
  configureInternalMcpServers(undefined);
});

describe("dashboard response ingestion", () => {
  it("configures internal MCP labels after validation", () => {
    ingestDashboardResponse({
      records: [
        {
          date: "2026-09-20",
          userId: "user-1",
          email: "user@example.test",
          displayName: "Example User",
          server: "example-internal",
          tool: "search",
          usage: 3,
          origin: "internal",
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
    });

    expect(classifyMcpServer("example-internal")).toBe("internal");
  });
});
