import { describe, expect, it } from "vitest";
import { buildWeeklyComparison } from "./kpi-comparison";
import type { McpRecord } from "../../contracts/mcp-response";

function record(
  date: string,
  usage: number,
  email = "user@example.com",
): McpRecord {
  return {
    date,
    usage,
    email,
    userId: email,
    displayName: email,
    server: "github",
    tool: "search",
  };
}

describe("buildWeeklyComparison", () => {
  it("anchors both windows to the selected range end", () => {
    const comparison = buildWeeklyComparison(
      [
        record("2026-09-01", 100),
        record("2026-09-07", 10),
        record("2026-09-14", 5),
      ],
      { startDate: "2026-09-01", endDate: "2026-09-20" },
      { startDate: "2026-09-01", endDate: "2026-09-20" },
    );

    expect(comparison?.previous.totalUsage).toBe(10);
    expect(comparison?.current.totalUsage).toBe(5);
    expect(comparison?.calls).toBe(-50);
  });

  it("returns an honest zero-activity current window", () => {
    const comparison = buildWeeklyComparison(
      [record("2026-09-10", 12)],
      { startDate: "2026-09-01", endDate: "2026-09-20" },
      { startDate: "2026-09-01", endDate: "2026-09-20" },
    );

    expect(comparison).toMatchObject({
      current: {
        totalUsage: 0,
        uniqueUsers: 0,
        uniqueServers: 0,
        uniqueTools: 0,
      },
      previous: { totalUsage: 12 },
      calls: -100,
      users: -1,
      servers: -1,
      tools: -1,
    });
  });

  it("excludes an incomplete range end from both comparison windows", () => {
    const comparison = buildWeeklyComparison(
      [
        record("2026-09-12", 10),
        record("2026-09-19", 20),
        record("2026-09-20", 1_000),
      ],
      { startDate: "2026-09-01", endDate: "2026-09-20" },
      { startDate: "2026-09-01", endDate: "2026-09-20" },
      true,
    );

    expect(comparison?.previous.totalUsage).toBe(10);
    expect(comparison?.current.totalUsage).toBe(20);
    expect(comparison?.calls).toBe(100);
  });

  it("suppresses comparison only when source coverage is incomplete", () => {
    const activeRange = {
      startDate: "2026-09-14",
      endDate: "2026-09-20",
    };

    expect(
      buildWeeklyComparison([], activeRange, {
        startDate: "2026-09-08",
        endDate: "2026-09-20",
      }),
    ).toBeNull();
    expect(
      buildWeeklyComparison([], activeRange, {
        startDate: "2026-09-07",
        endDate: "2026-09-20",
      }),
    ).not.toBeNull();
  });
});
