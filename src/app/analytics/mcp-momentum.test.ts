import { describe, expect, it } from "vitest";
import { buildMcpMomentum } from "./mcp-momentum";
import type { Filters, TemporalFilterField } from "../scope/filter-model";
import type { McpRecord } from "../../contracts/mcp-response";

function record(
  date: string,
  server: string,
  usage: number,
  tool = "search",
): McpRecord {
  return {
    date,
    server,
    usage,
    tool,
    userId: "user-1",
    email: "user@example.com",
    displayName: "Example User",
  };
}

function temporalFilters(
  changes: Partial<Pick<Filters, TemporalFilterField>> = {},
): Pick<Filters, TemporalFilterField> {
  return {
    dates: [],
    days: [],
    weeks: [],
    months: [],
    monthYears: [],
    quarters: [],
    years: [],
    ...changes,
  };
}

describe("buildMcpMomentum", () => {
  it("compares adjacent equal halves and aggregates each server", () => {
    const result = buildMcpMomentum(
      [
        record("2026-09-01", "github", 4),
        record("2026-09-02", "github", 6, "issues"),
        record("2026-09-04", "github", 12),
        record("2026-09-06", "github", 8, "issues"),
      ],
      { startDate: "2026-09-01", endDate: "2026-09-06" },
      temporalFilters(),
    );

    expect(result).toMatchObject({
      status: "ready",
      previousPeriod: {
        startDate: "2026-09-01",
        endDate: "2026-09-03",
        days: 3,
      },
      currentPeriod: {
        startDate: "2026-09-04",
        endDate: "2026-09-06",
        days: 3,
      },
      increased: [
        {
          server: "github",
          previousCalls: 10,
          currentCalls: 20,
          change: 10,
          percentageChange: 100,
          status: "changed",
        },
      ],
    });
  });

  it("drops the oldest day from an odd span", () => {
    const result = buildMcpMomentum(
      [],
      { startDate: "2026-09-01", endDate: "2026-09-07" },
      temporalFilters(),
    );

    expect(result).toMatchObject({
      status: "ready",
      omittedLeadingDate: "2026-09-01",
      previousPeriod: {
        startDate: "2026-09-02",
        endDate: "2026-09-04",
      },
      currentPeriod: {
        startDate: "2026-09-05",
        endDate: "2026-09-07",
      },
    });
  });

  it("omits a potentially incomplete final day before splitting", () => {
    const result = buildMcpMomentum(
      [],
      { startDate: "2026-09-01", endDate: "2026-09-07" },
      temporalFilters(),
      true,
    );

    expect(result).toMatchObject({
      status: "ready",
      omittedLeadingDate: null,
      previousPeriod: {
        startDate: "2026-09-01",
        endDate: "2026-09-03",
      },
      currentPeriod: {
        startDate: "2026-09-04",
        endDate: "2026-09-06",
      },
    });
  });

  it("requires six complete days", () => {
    expect(
      buildMcpMomentum(
        [],
        { startDate: "2026-09-01", endDate: "2026-09-05" },
        temporalFilters(),
      ),
    ).toEqual({
      status: "insufficient-history",
      availableDays: 5,
    });
  });

  it("rejects disjoint temporal selections", () => {
    expect(
      buildMcpMomentum(
        [],
        { startDate: "2026-09-01", endDate: "2026-09-12" },
        temporalFilters({
          dates: [
            "2026-09-01",
            "2026-09-03",
            "2026-09-05",
            "2026-09-07",
            "2026-09-09",
            "2026-09-11",
          ],
        }),
      ),
    ).toEqual({
      status: "disjoint-range",
      availableDays: 6,
    });
  });

  it("labels new, inactive, and unchanged servers honestly", () => {
    const result = buildMcpMomentum(
      [
        record("2026-09-01", "inactive", 8),
        record("2026-09-02", "unchanged", 5),
        record("2026-09-04", "new", 11),
        record("2026-09-05", "unchanged", 5),
      ],
      { startDate: "2026-09-01", endDate: "2026-09-06" },
      temporalFilters(),
    );

    expect(result).toMatchObject({
      status: "ready",
      increased: [
        {
          server: "new",
          previousCalls: 0,
          currentCalls: 11,
          percentageChange: null,
          status: "new",
        },
      ],
      decreased: [
        {
          server: "inactive",
          previousCalls: 8,
          currentCalls: 0,
          percentageChange: -100,
          status: "inactive",
        },
      ],
      unchangedCount: 1,
    });
  });

  it("sorts by absolute change, current volume, then server label", () => {
    const result = buildMcpMomentum(
      [
        record("2026-09-01", "zeta", 10),
        record("2026-09-01", "beta", 20),
        record("2026-09-01", "alpha", 20),
        record("2026-09-04", "zeta", 20),
        record("2026-09-04", "beta", 30),
        record("2026-09-04", "alpha", 30),
      ],
      { startDate: "2026-09-01", endDate: "2026-09-06" },
      temporalFilters(),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.increased.map((item) => item.server)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  it("preserves the direction of sub-one-percent changes", () => {
    const result = buildMcpMomentum(
      [
        record("2026-09-01", "slight-decrease", 1_000),
        record("2026-09-04", "slight-decrease", 999),
      ],
      { startDate: "2026-09-01", endDate: "2026-09-06" },
      temporalFilters(),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.decreased[0].percentageChange).toBeCloseTo(-0.1);
  });
});
