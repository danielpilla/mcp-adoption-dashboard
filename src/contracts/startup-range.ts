import { isRangeDays, MAX_DATE_RANGE_DAYS } from "./date-range-days.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * The range the dashboard loads at startup. A preset is a rolling window
 * that ends on the current UTC day; a custom range has fixed dates.
 */
export type StartupRange =
  | { kind: "preset"; days: number }
  | { kind: "custom"; startDate: string; endDate: string };

/** Day coverage of the per-day activity cache. */
export interface CacheCoverage {
  /** Oldest cached day, or null when nothing is cached. */
  firstDate: string | null;
  /** Newest cached day, or null when nothing is cached. */
  lastDate: string | null;
  /** Number of cached days. */
  days: number;
  /** Newest day that can be cached; later days are always refetched. */
  cacheableThrough: string;
  /** Contiguous runs of cached days, oldest first. */
  spans: { startDate: string; endDate: string }[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** Inclusive number of days from `startDate` through `endDate`. */
export function daysBetween(startDate: string, endDate: string): number {
  return (
    Math.round(
      (Date.parse(`${endDate}T00:00:00.000Z`) -
        Date.parse(`${startDate}T00:00:00.000Z`)) /
        DAY_MS,
    ) + 1
  );
}

/** Validates a startup range and strips unknown fields. */
export function parseStartupRange(value: unknown): StartupRange | null {
  if (!isObject(value)) return null;
  if (value.kind === "preset") {
    return isRangeDays(value.days)
      ? { kind: "preset", days: value.days }
      : null;
  }
  if (
    value.kind === "custom" &&
    isIsoDate(value.startDate) &&
    isIsoDate(value.endDate) &&
    value.startDate <= value.endDate &&
    daysBetween(value.startDate, value.endDate) <= MAX_DATE_RANGE_DAYS
  ) {
    return {
      kind: "custom",
      startDate: value.startDate,
      endDate: value.endDate,
    };
  }
  return null;
}

const MAX_COVERAGE_SPANS = 400;

/** Validates cache coverage from the server, or returns null. */
export function parseCacheCoverage(value: unknown): CacheCoverage | null {
  if (
    !isObject(value) ||
    !isIsoDate(value.cacheableThrough) ||
    typeof value.days !== "number" ||
    !Number.isSafeInteger(value.days) ||
    value.days < 0 ||
    !Array.isArray(value.spans) ||
    value.spans.length > MAX_COVERAGE_SPANS
  ) {
    return null;
  }
  const spans: CacheCoverage["spans"] = [];
  for (const span of value.spans) {
    if (
      !isObject(span) ||
      !isIsoDate(span.startDate) ||
      !isIsoDate(span.endDate) ||
      span.startDate > span.endDate
    ) {
      return null;
    }
    spans.push({ startDate: span.startDate, endDate: span.endDate });
  }
  return {
    firstDate: isIsoDate(value.firstDate) ? value.firstDate : null,
    lastDate: isIsoDate(value.lastDate) ? value.lastDate : null,
    days: value.days,
    cacheableThrough: value.cacheableThrough,
    spans,
  };
}

/**
 * Summarizes sorted cached dates into coverage without reading any day file.
 * Only the newest `MAX_COVERAGE_SPANS` runs are listed so the response stays
 * small; `days`, `firstDate`, and `lastDate` always describe every date.
 */
export function summarizeCoverage(
  sortedDates: readonly string[],
  cacheableThrough: string,
): CacheCoverage {
  const spans: CacheCoverage["spans"] = [];
  let previous: string | undefined;
  for (const date of sortedDates) {
    const last = spans.at(-1);
    if (last && previous && daysBetween(previous, date) === 2) {
      last.endDate = date;
    } else {
      spans.push({ startDate: date, endDate: date });
    }
    previous = date;
  }
  return {
    firstDate: sortedDates[0] ?? null,
    lastDate: sortedDates.at(-1) ?? null,
    days: sortedDates.length,
    cacheableThrough,
    spans: spans.slice(-MAX_COVERAGE_SPANS),
  };
}
