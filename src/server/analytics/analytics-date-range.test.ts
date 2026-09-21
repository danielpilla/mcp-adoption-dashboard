import { describe, expect, it } from "vitest";
import { MAX_DATE_RANGE_DAYS, validateDateRange } from "./analytics-date-range";

const NOW = new Date("2026-09-21T12:00:00Z");

describe("validateDateRange", () => {
  it("accepts an inclusive ISO range", () => {
    expect(validateDateRange("2026-06-01", "2026-09-18", NOW)).toEqual({
      startDate: "2026-06-01",
      endDate: "2026-09-18",
    });
  });

  it.each([
    ["09/01/2026", "2026-09-18"],
    ["2026-02-30", "2026-09-18"],
    ["2026-09-18", "2026-09-01"],
  ])("rejects invalid range %s to %s", (start, end) => {
    expect(() => validateDateRange(start, end, NOW)).toThrow(RangeError);
  });

  it(`allows at most ${MAX_DATE_RANGE_DAYS} inclusive days`, () => {
    expect(
      validateDateRange(
        "2024-01-01",
        "2024-12-31",
        new Date("2025-01-01T12:00:00Z"),
      ),
    ).toEqual({
      startDate: "2024-01-01",
      endDate: "2024-12-31",
    });
    expect(() =>
      validateDateRange(
        "2024-01-01",
        "2025-01-01",
        new Date("2025-01-01T12:00:00Z"),
      ),
    ).toThrow("date range cannot exceed 366 days");
  });

  it("rejects a future end date", () => {
    expect(() =>
      validateDateRange(
        "2026-09-01",
        "2026-09-21",
        new Date("2026-09-20T23:59:59Z"),
      ),
    ).toThrow("endDate cannot be in the future");
  });
});
