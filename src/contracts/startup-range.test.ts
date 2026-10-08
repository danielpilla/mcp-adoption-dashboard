import { describe, expect, it } from "vitest";
import {
  daysBetween,
  isIsoDate,
  parseCacheCoverage,
  parseStartupRange,
  summarizeCoverage,
} from "./startup-range";

describe("startup range contract", () => {
  it("counts days inclusively", () => {
    expect(daysBetween("2026-09-01", "2026-09-01")).toBe(1);
    expect(daysBetween("2026-09-01", "2026-09-30")).toBe(30);
    expect(daysBetween("2024-03-01", "2025-02-28")).toBe(365);
    expect(daysBetween("2024-01-01", "2024-12-31")).toBe(366);
  });

  it("accepts only real calendar dates", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-9-01")).toBe(false);
    expect(isIsoDate(20260901)).toBe(false);
  });

  it.each([
    [
      { kind: "preset", days: 1 },
      { kind: "preset", days: 1 },
    ],
    [
      { kind: "preset", days: 366, extra: 1 },
      { kind: "preset", days: 366 },
    ],
    [
      { kind: "custom", startDate: "2024-01-01", endDate: "2024-12-31" },
      { kind: "custom", startDate: "2024-01-01", endDate: "2024-12-31" },
    ],
  ])("parses the valid range %j", (value, expected) => {
    expect(parseStartupRange(value)).toEqual(expected);
  });

  it.each([
    null,
    "preset",
    [],
    { kind: "preset", days: 0 },
    { kind: "preset", days: 367 },
    { kind: "preset", days: 7.5 },
    { kind: "preset", days: "30" },
    { kind: "custom", startDate: "2026-09-02", endDate: "2026-09-01" },
    { kind: "custom", startDate: "2024-01-01", endDate: "2025-01-01" },
    { kind: "custom", startDate: "2026-02-30", endDate: "2026-03-01" },
    { kind: "custom", startDate: "2026-09-01" },
    { kind: "rolling", days: 30 },
  ])("rejects the invalid range %j", (value) => {
    expect(parseStartupRange(value)).toBeNull();
  });

  it("summarizes sorted dates into contiguous spans", () => {
    expect(
      summarizeCoverage(
        [
          "2026-08-30",
          "2026-08-31",
          "2026-09-01",
          "2026-09-03",
          "2026-09-05",
          "2026-09-06",
        ],
        "2026-09-17",
      ),
    ).toEqual({
      firstDate: "2026-08-30",
      lastDate: "2026-09-06",
      days: 6,
      cacheableThrough: "2026-09-17",
      spans: [
        { startDate: "2026-08-30", endDate: "2026-09-01" },
        { startDate: "2026-09-03", endDate: "2026-09-03" },
        { startDate: "2026-09-05", endDate: "2026-09-06" },
      ],
    });
  });

  it("summarizes an empty cache", () => {
    expect(summarizeCoverage([], "2026-09-17")).toEqual({
      firstDate: null,
      lastDate: null,
      days: 0,
      cacheableThrough: "2026-09-17",
      spans: [],
    });
  });

  it("keeps only the newest spans while counting every day", () => {
    const dates = Array.from({ length: 500 }, (_, index) => {
      const date = new Date(Date.UTC(2024, 0, 1 + index * 2));
      return date.toISOString().slice(0, 10);
    });
    const coverage = summarizeCoverage(dates, "2026-12-31");

    expect(coverage.days).toBe(500);
    expect(coverage.firstDate).toBe(dates[0]);
    expect(coverage.spans).toHaveLength(400);
    expect(coverage.spans.at(-1)?.endDate).toBe(dates.at(-1));
    expect(parseCacheCoverage(coverage)).toEqual(coverage);
  });

  it("rejects malformed coverage", () => {
    const valid = summarizeCoverage(["2026-09-01"], "2026-09-17");
    expect(parseCacheCoverage(valid)).toEqual(valid);
    expect(parseCacheCoverage(null)).toBeNull();
    expect(parseCacheCoverage({ ...valid, days: -1 })).toBeNull();
    expect(
      parseCacheCoverage({ ...valid, cacheableThrough: "soon" }),
    ).toBeNull();
    expect(
      parseCacheCoverage({
        ...valid,
        spans: [{ startDate: "2026-09-02", endDate: "2026-09-01" }],
      }),
    ).toBeNull();
    expect(
      parseCacheCoverage({
        ...valid,
        spans: Array.from({ length: 401 }, () => valid.spans[0]),
      }),
    ).toBeNull();
  });
});
