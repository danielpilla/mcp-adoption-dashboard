import type { ActivityLoadProgress } from "./dashboard-stream";

/** No new page or window for this long marks the load as slow. */
const SLOW_AFTER_MS = 15_000;
/** No stream event for this long marks the connection as quiet. */
const QUIET_AFTER_MS = 8_000;
/** Estimates start after this much time and fetched work. */
const MIN_ESTIMATE_ELAPSED_MS = 3_000;
const MIN_ESTIMATE_FRACTION = 0.03;

export type LoadState =
  "starting" | "loading" | "retrying" | "slow" | "quiet" | "reused" | "ready";

const countFormat = new Intl.NumberFormat("en-US");

export function formatCountValue(value: number): string {
  return countFormat.format(value);
}

/**
 * Fetched days including the finished share of running windows. A running
 * window counts by pages once its page count is known and never as finished.
 */
export function fetchedDayEquivalent(activity: ActivityLoadProgress): number {
  const partial = activity.windows.reduce((total, window) => {
    if (!window.totalPages) return total;
    const share = Math.min(0.95, window.pagesLoaded / window.totalPages);
    return total + share * window.days;
  }, 0);
  return Math.min(
    Math.max(0, activity.totalDays - activity.cachedDays),
    activity.fetchedDays + partial,
  );
}

/** Fraction of the range's days that are loaded, from 0 to 1. */
export function loadedRatio(activity: ActivityLoadProgress): number {
  if (activity.state !== "loading") return 1;
  if (activity.totalDays === 0) return 0;
  return Math.min(
    1,
    (activity.cachedDays + activity.fetchedDays) / activity.totalDays,
  );
}

/**
 * Estimated time until the remaining uncached days are fetched, from the
 * rate observed so far. Returns null until enough work has finished to
 * estimate, and 0 once nothing is left to fetch.
 */
export function estimateRemainingMs(
  activity: ActivityLoadProgress,
): number | null {
  if (activity.state !== "loading") return 0;
  const toFetch = activity.totalDays - activity.cachedDays;
  if (toFetch <= 0) return 0;
  const fetched = fetchedDayEquivalent(activity);
  if (
    activity.elapsedMs < MIN_ESTIMATE_ELAPSED_MS ||
    fetched <= 0 ||
    fetched / toFetch < MIN_ESTIMATE_FRACTION
  ) {
    return null;
  }
  const remaining = toFetch - fetched;
  if (remaining <= 0) return 0;
  return Math.round((remaining * activity.elapsedMs) / fetched);
}

/**
 * The state to show. `sinceEventMs` is how long ago the latest event
 * arrived, so a stalled connection is visible between server heartbeats.
 */
export function describeLoadState(
  activity: ActivityLoadProgress | undefined,
  sinceEventMs: number,
): LoadState {
  if (!activity) return sinceEventMs >= QUIET_AFTER_MS ? "quiet" : "starting";
  if (activity.state === "ready") return "ready";
  if (activity.state === "reused") return "reused";
  if (activity.retry) return "retrying";
  if (sinceEventMs >= QUIET_AFTER_MS) return "quiet";
  if (
    activity.idleMs + sinceEventMs >= SLOW_AFTER_MS &&
    activity.totalDays > activity.cachedDays
  ) {
    return "slow";
  }
  return "loading";
}

/** Elapsed time such as `8s`, `1m 05s`, or `1h 02m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A rounded estimate such as `about 40s`, `about 3 min`, or `under 5s`. */
export function formatEstimate(ms: number): string {
  if (ms < 5_000) return "under 5s";
  if (ms < 60_000) return `about ${Math.ceil(ms / 5_000) * 5}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours} h` : `about ${hours} h ${rest} min`;
}

/** Remaining wait before a retry, in milliseconds. */
export function retryRemainingMs(
  activity: ActivityLoadProgress,
  sinceEventMs: number,
): number {
  if (!activity.retry) return 0;
  return Math.max(
    0,
    activity.retry.delayMs - activity.retry.waitedMs - sinceEventMs,
  );
}
