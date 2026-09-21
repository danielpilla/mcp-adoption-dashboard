import { describe, expect, it } from "vitest";
import {
  formatIsoDate,
  inclusiveDayCount,
  parseIsoDate,
  rangeLabel,
  shiftIsoDate,
} from "./dashboard-dates";

describe("dashboard date helpers", () => {
  it("parses date-only values at UTC midnight", () => {
    expect(parseIsoDate("2026-09-21").toISOString()).toBe(
      "2026-09-21T00:00:00.000Z",
    );
  });

  it("shifts dates across month and leap-year boundaries", () => {
    expect(shiftIsoDate("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftIsoDate("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("counts inclusive UTC calendar days", () => {
    expect(
      inclusiveDayCount({
        startDate: "2024-02-28",
        endDate: "2024-03-01",
      }),
    ).toBe(3);
  });

  it("formats chart and range labels consistently in UTC", () => {
    expect(
      formatIsoDate("2026-09-21", { month: "short", day: "numeric" }),
    ).toBe("Sep 21");
    expect(rangeLabel("2026-09-01", "2026-09-21")).toBe(
      "Sep 1, 2026 – Sep 21, 2026",
    );
  });
});
