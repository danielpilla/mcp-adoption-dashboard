import { describe, expect, it } from "vitest";
import type { ActivityLoadProgress } from "./dashboard-stream";
import {
  describeLoadState,
  estimateRemainingMs,
  fetchedDayEquivalent,
  formatCountValue,
  formatElapsed,
  formatEstimate,
  loadedRatio,
  retryRemainingMs,
} from "./load-progress";

function activity(
  overrides: Partial<ActivityLoadProgress> = {},
): ActivityLoadProgress {
  return {
    state: "loading",
    totalDays: 100,
    cachedDays: 40,
    fetchedDays: 30,
    records: 1_000,
    completedWindows: 1,
    totalWindows: 2,
    windows: [],
    retry: null,
    elapsedMs: 10_000,
    idleMs: 0,
    ...overrides,
  };
}

const runningWindow = {
  startDate: "2026-06-01",
  endDate: "2026-06-30",
  days: 30,
  pagesLoaded: 1,
  totalPages: 4,
};

describe("load progress", () => {
  it("counts loaded days from the cache and finished windows", () => {
    expect(loadedRatio(activity())).toBe(0.7);
    expect(loadedRatio(activity({ totalDays: 0, cachedDays: 0 }))).toBe(0);
    expect(loadedRatio(activity({ state: "reused" }))).toBe(1);
  });

  it("adds the finished page share of running windows", () => {
    expect(fetchedDayEquivalent(activity({ windows: [runningWindow] }))).toBe(
      37.5,
    );
    expect(
      fetchedDayEquivalent(
        activity({
          windows: [{ ...runningWindow, pagesLoaded: 4, totalPages: 4 }],
        }),
      ),
    ).toBe(58.5);
    expect(
      fetchedDayEquivalent(
        activity({ windows: [{ ...runningWindow, totalPages: null }] }),
      ),
    ).toBe(30);
  });

  it("estimates the remaining time from the observed rate", () => {
    expect(estimateRemainingMs(activity())).toBe(10_000);
    expect(estimateRemainingMs(activity({ windows: [runningWindow] }))).toBe(
      6_000,
    );
    expect(estimateRemainingMs(activity({ fetchedDays: 60 }))).toBe(0);
    expect(estimateRemainingMs(activity({ cachedDays: 100 }))).toBe(0);
    expect(estimateRemainingMs(activity({ state: "ready" }))).toBe(0);
  });

  it("waits for enough work before estimating", () => {
    expect(estimateRemainingMs(activity({ elapsedMs: 2_000 }))).toBeNull();
    expect(estimateRemainingMs(activity({ fetchedDays: 0 }))).toBeNull();
    expect(
      estimateRemainingMs(
        activity({ cachedDays: 0, totalDays: 366, fetchedDays: 10 }),
      ),
    ).toBeNull();
  });

  it.each([
    [undefined, 0, "starting"],
    [undefined, 9_000, "quiet"],
    [activity(), 0, "loading"],
    [activity({ idleMs: 14_000 }), 2_000, "slow"],
    [activity({ idleMs: 20_000, cachedDays: 100 }), 0, "loading"],
    [activity(), 8_000, "quiet"],
    [activity({ state: "reused" }), 0, "reused"],
    [activity({ state: "ready" }), 0, "ready"],
    [
      activity({
        retry: {
          attempt: 2,
          maxAttempts: 5,
          delayMs: 4_000,
          waitedMs: 1_000,
          reason: "rate_limited",
          status: 429,
        },
        idleMs: 30_000,
      }),
      0,
      "retrying",
    ],
  ])("describes %j after %i ms as %s", (value, sinceEventMs, expected) => {
    expect(describeLoadState(value, sinceEventMs)).toBe(expected);
  });

  it("counts down a retry wait between events", () => {
    const retrying = activity({
      retry: {
        attempt: 3,
        maxAttempts: 5,
        delayMs: 4_000,
        waitedMs: 1_000,
        reason: "server_error",
        status: 503,
      },
    });
    expect(retryRemainingMs(retrying, 500)).toBe(2_500);
    expect(retryRemainingMs(retrying, 5_000)).toBe(0);
    expect(retryRemainingMs(activity(), 0)).toBe(0);
  });

  it.each([
    [0, "0s"],
    [59_999, "59s"],
    [65_000, "1m 05s"],
    [3_723_000, "1h 02m"],
  ])("formats %i ms elapsed as %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });

  it.each([
    [1_000, "under 5s"],
    [12_000, "about 15s"],
    [150_000, "about 3 min"],
    [3_600_000, "about 1 h"],
    [5_400_000, "about 1 h 30 min"],
  ])("formats a %i ms estimate as %s", (ms, expected) => {
    expect(formatEstimate(ms)).toBe(expected);
  });

  it("groups large counts", () => {
    expect(formatCountValue(1_234_567)).toBe("1,234,567");
  });
});
