import { describe, expect, it, vi } from "vitest";
import {
  summarizeCoverage,
  type CacheCoverage,
} from "../../contracts/startup-range";
import {
  STARTUP_RANGE_STORAGE_KEY,
  checkCustomRange,
  largestCachedPreset,
  loadEffort,
  planStartup,
  rangeCoverage,
  readLocalStartupRange,
  resolveStartupRange,
  sameStartupRange,
  saveStartupRange,
} from "./range-choice";

const today = "2026-09-20";
const cacheableThrough = "2026-09-17";

function coverageFrom(startDate: string, endDate = cacheableThrough) {
  const dates: string[] = [];
  for (
    let date = new Date(`${startDate}T00:00:00Z`);
    date <= new Date(`${endDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return summarizeCoverage(dates, cacheableThrough);
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe("startup range choice", () => {
  it("resolves presets as rolling ranges and keeps custom dates", () => {
    expect(resolveStartupRange({ kind: "preset", days: 7 }, today)).toEqual({
      startDate: "2026-09-14",
      endDate: today,
    });
    expect(
      resolveStartupRange(
        { kind: "custom", startDate: "2026-01-01", endDate: "2026-01-31" },
        today,
      ),
    ).toEqual({ startDate: "2026-01-01", endDate: "2026-01-31" });
  });

  it("compares ranges by kind and value", () => {
    expect(
      sameStartupRange(
        { kind: "preset", days: 30 },
        { kind: "preset", days: 30 },
      ),
    ).toBe(true);
    expect(
      sameStartupRange(
        { kind: "preset", days: 30 },
        { kind: "preset", days: 7 },
      ),
    ).toBe(false);
    expect(sameStartupRange(null, { kind: "preset", days: 30 })).toBe(false);
  });

  it("measures cache coverage within the cacheable days", () => {
    const coverage = coverageFrom("2026-08-01");
    expect(
      rangeCoverage(
        coverage,
        resolveStartupRange({ kind: "preset", days: 30 }, today),
      ),
    ).toEqual({
      totalDays: 30,
      cacheableDays: 27,
      cachedDays: 27,
      status: "full",
    });
    expect(
      rangeCoverage(
        coverage,
        resolveStartupRange({ kind: "preset", days: 90 }, today),
      ),
    ).toEqual({
      totalDays: 90,
      cacheableDays: 87,
      cachedDays: 48,
      status: "partial",
    });
    expect(
      rangeCoverage(coverage, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }),
    ).toEqual({
      totalDays: 31,
      cacheableDays: 31,
      cachedDays: 0,
      status: "none",
    });
    expect(
      rangeCoverage(null, { startDate: "2026-09-01", endDate: "2026-09-10" }),
    ).toEqual({
      totalDays: 10,
      cacheableDays: 0,
      cachedDays: 0,
      status: "none",
    });
  });

  it("counts gaps between cached spans", () => {
    const coverage: CacheCoverage = {
      ...coverageFrom("2026-09-01", "2026-09-05"),
      spans: [
        { startDate: "2026-09-01", endDate: "2026-09-02" },
        { startDate: "2026-09-04", endDate: "2026-09-05" },
      ],
    };
    expect(
      rangeCoverage(coverage, {
        startDate: "2026-09-02",
        endDate: "2026-09-04",
      }),
    ).toMatchObject({ cachedDays: 2, status: "partial" });
  });

  it("finds the largest fully cached preset", () => {
    expect(largestCachedPreset(coverageFrom("2026-03-24"), today)).toBe(180);
    expect(largestCachedPreset(coverageFrom("2026-08-01"), today)).toBe(30);
    expect(largestCachedPreset(coverageFrom("2026-09-15"), today)).toBe(null);
    expect(largestCachedPreset(null, today)).toBe(null);
  });

  it("loads a remembered range at once when any of its days are cached", () => {
    const remembered = { kind: "preset", days: 90 } as const;
    expect(
      planStartup({
        remembered,
        coverage: coverageFrom("2026-09-01"),
        defaultRangeDays: 30,
        today,
      }),
    ).toEqual({ selection: remembered, autoLoad: true });
    expect(
      planStartup({ remembered, coverage: null, defaultRangeDays: 30, today }),
    ).toEqual({ selection: remembered, autoLoad: false });
  });

  it("asks for a range when nothing usable is remembered", () => {
    // A custom range that ends in the future is not usable.
    expect(
      planStartup({
        remembered: null,
        coverage: coverageFrom("2026-08-01"),
        defaultRangeDays: 90,
        today,
      }),
    ).toEqual({ selection: { kind: "preset", days: 30 }, autoLoad: false });
    expect(
      planStartup({
        remembered: null,
        coverage: null,
        defaultRangeDays: 14,
        today,
      }),
    ).toEqual({ selection: { kind: "preset", days: 14 }, autoLoad: false });
    expect(
      planStartup({
        remembered: {
          kind: "custom",
          startDate: "2026-09-01",
          endDate: "2026-09-30",
        },
        coverage: null,
        defaultRangeDays: 90,
        today,
      }),
    ).toEqual({ selection: { kind: "preset", days: 90 }, autoLoad: false });
  });

  it.each([
    ["2026-09-01", "2026-09-20", { valid: true, days: 20 }],
    ["2025-09-20", "2026-09-20", { valid: true, days: 366 }],
    ["2026-09-20", "2026-09-20", { valid: true, days: 1 }],
    [
      "",
      "2026-09-20",
      { valid: false, days: null, error: "Enter a start and end date." },
    ],
    [
      "2026-09-21",
      "2026-09-20",
      {
        valid: false,
        days: null,
        error: "The start date must be on or before the end date.",
      },
    ],
    [
      "2026-09-01",
      "2026-09-21",
      { valid: false, days: 21, error: "The end date can’t be in the future." },
    ],
    [
      "2025-09-19",
      "2026-09-20",
      {
        valid: false,
        days: 367,
        error: "Ranges are limited to 366 days; this one is 367.",
      },
    ],
  ])("checks the custom range %s to %s", (startDate, endDate, expected) => {
    expect(checkCustomRange(startDate, endDate, today)).toEqual(expected);
  });

  it.each([
    [1, 1],
    [7, 1],
    [8, 2],
    [30, 2],
    [90, 3],
    [180, 4],
    [181, 5],
    [366, 5],
  ])("rates fetching %i days as effort %i", (days, effort) => {
    expect(loadEffort(days)).toBe(effort);
  });

  it("saves to the server and this browser", async () => {
    const storage = memoryStorage();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      saveStartupRange({ kind: "preset", days: 30 }, { storage, fetcher }),
    ).resolves.toBe("server");

    expect(fetcher).toHaveBeenCalledWith("/api/setup/range", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "preset", days: 30 }),
    });
    expect(readLocalStartupRange(storage)).toEqual({
      kind: "preset",
      days: 30,
    });
  });

  it("falls back to this browser when the server cannot save", async () => {
    const storage = memoryStorage();
    const rejected = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 503 }));
    const offline = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("offline"));

    await expect(
      saveStartupRange(
        { kind: "preset", days: 7 },
        { storage, fetcher: rejected },
      ),
    ).resolves.toBe("browser");
    await expect(
      saveStartupRange(
        { kind: "preset", days: 180 },
        { storage, fetcher: offline },
      ),
    ).resolves.toBe("browser");
    expect(readLocalStartupRange(storage)).toEqual({
      kind: "preset",
      days: 180,
    });
    await expect(
      saveStartupRange(
        { kind: "preset", days: 7 },
        { storage: null, fetcher: offline },
      ),
    ).resolves.toBe("none");
  });

  it("still saves to the server when browser storage throws", async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      saveStartupRange({ kind: "preset", days: 7 }, { storage, fetcher }),
    ).resolves.toBe("server");
  });

  it("ignores an invalid browser copy", () => {
    expect(
      readLocalStartupRange(
        memoryStorage({ [STARTUP_RANGE_STORAGE_KEY]: "{" }),
      ),
    ).toBeNull();
    expect(
      readLocalStartupRange(
        memoryStorage({
          [STARTUP_RANGE_STORAGE_KEY]: JSON.stringify({
            kind: "preset",
            days: 0,
          }),
        }),
      ),
    ).toBeNull();
    expect(readLocalStartupRange(null)).toBeNull();
  });
});
