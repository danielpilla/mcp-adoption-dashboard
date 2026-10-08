import { MAX_DATE_RANGE_DAYS } from "../../contracts/date-range-days";
import type { DateRange } from "../../contracts/mcp-response";
import {
  daysBetween,
  isIsoDate,
  parseStartupRange,
  type CacheCoverage,
  type StartupRange,
} from "../../contracts/startup-range";
import { shiftIsoDate } from "../dashboard/dashboard-dates";

export const STARTUP_PRESETS = [7, 30, 90, 180, 365] as const;

export const STARTUP_RANGE_STORAGE_KEY = "mcp-dashboard.startup-range";

type CoverageStatus = "full" | "partial" | "none";

export interface RangeCoverage {
  totalDays: number;
  /** Days that can be cached; the newest days are always refetched. */
  cacheableDays: number;
  cachedDays: number;
  status: CoverageStatus;
}

/** The dates a startup range covers when loaded on `today`. */
export function resolveStartupRange(
  range: StartupRange,
  today: string,
): DateRange {
  if (range.kind === "custom") {
    return { startDate: range.startDate, endDate: range.endDate };
  }
  return { startDate: shiftIsoDate(today, 1 - range.days), endDate: today };
}

export function sameStartupRange(
  a: StartupRange | null,
  b: StartupRange | null,
): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "preset" && b.kind === "preset") return a.days === b.days;
  return (
    a.kind === "custom" &&
    b.kind === "custom" &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate
  );
}

/** How much of `range` the per-day cache already holds. */
export function rangeCoverage(
  coverage: CacheCoverage | null,
  range: DateRange,
): RangeCoverage {
  const totalDays = daysBetween(range.startDate, range.endDate);
  if (!coverage) {
    return { totalDays, cacheableDays: 0, cachedDays: 0, status: "none" };
  }
  const cacheableEnd =
    range.endDate < coverage.cacheableThrough
      ? range.endDate
      : coverage.cacheableThrough;
  const cacheableDays =
    cacheableEnd >= range.startDate
      ? daysBetween(range.startDate, cacheableEnd)
      : 0;
  let cachedDays = 0;
  for (const span of coverage.spans) {
    const start =
      span.startDate > range.startDate ? span.startDate : range.startDate;
    const end = span.endDate < cacheableEnd ? span.endDate : cacheableEnd;
    if (start <= end) cachedDays += daysBetween(start, end);
  }
  const status: CoverageStatus =
    cachedDays === 0
      ? "none"
      : cachedDays >= cacheableDays
        ? "full"
        : "partial";
  return { totalDays, cacheableDays, cachedDays, status };
}

/** The largest preset whose cacheable days are all cached, if any. */
export function largestCachedPreset(
  coverage: CacheCoverage | null,
  today: string,
): number | null {
  let largest: number | null = null;
  for (const days of STARTUP_PRESETS) {
    const range = resolveStartupRange({ kind: "preset", days }, today);
    if (rangeCoverage(coverage, range).status === "full") largest = days;
  }
  return largest;
}

export interface StartupPlan {
  selection: StartupRange;
  /** Load without showing the range step. */
  autoLoad: boolean;
}

/**
 * Chooses the initial selection: the remembered range, else the largest
 * fully cached preset, else the configured default. A remembered range
 * loads automatically when the cache already holds some of its days;
 * otherwise the range step is shown first.
 */
export function planStartup({
  remembered,
  coverage,
  defaultRangeDays,
  today,
}: {
  remembered: StartupRange | null;
  coverage: CacheCoverage | null;
  defaultRangeDays: number;
  today: string;
}): StartupPlan {
  const usable =
    remembered && (remembered.kind === "preset" || remembered.endDate <= today)
      ? remembered
      : null;
  if (usable) {
    const warm =
      rangeCoverage(coverage, resolveStartupRange(usable, today)).cachedDays >
      0;
    return { selection: usable, autoLoad: warm };
  }
  const cachedPreset = largestCachedPreset(coverage, today);
  return {
    selection: {
      kind: "preset",
      days: cachedPreset ?? defaultRangeDays,
    },
    autoLoad: false,
  };
}

export type CustomRangeCheck =
  | { valid: true; days: number }
  | { valid: false; days: number | null; error: string };

/** Validates a custom range typed into the range step. */
export function checkCustomRange(
  startDate: string,
  endDate: string,
  today: string,
): CustomRangeCheck {
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    return { valid: false, days: null, error: "Enter a start and end date." };
  }
  if (startDate > endDate) {
    return {
      valid: false,
      days: null,
      error: "The start date must be on or before the end date.",
    };
  }
  const days = daysBetween(startDate, endDate);
  if (endDate > today) {
    return {
      valid: false,
      days,
      error: "The end date can’t be in the future.",
    };
  }
  if (days > MAX_DATE_RANGE_DAYS) {
    return {
      valid: false,
      days,
      error: `Ranges are limited to ${MAX_DATE_RANGE_DAYS} days; this one is ${days}.`,
    };
  }
  return { valid: true, days };
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The startup range saved in this browser, if any. */
export function readLocalStartupRange(
  storage: Storage | null = browserStorage(),
): StartupRange | null {
  try {
    const raw = storage?.getItem(STARTUP_RANGE_STORAGE_KEY);
    return raw ? parseStartupRange(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * Remembers the startup range on the server and in this browser. The
 * browser copy is the fallback when the server cannot store it. Resolves to
 * where the range was saved.
 */
export async function saveStartupRange(
  range: StartupRange,
  {
    storage = browserStorage(),
    fetcher = globalThis.fetch,
  }: { storage?: Storage | null; fetcher?: typeof fetch } = {},
): Promise<"server" | "browser" | "none"> {
  let local: boolean;
  try {
    storage?.setItem(STARTUP_RANGE_STORAGE_KEY, JSON.stringify(range));
    local = Boolean(storage);
  } catch {
    local = false;
  }
  try {
    const response = await fetcher("/api/setup/range", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(range),
    });
    if (response.ok) return "server";
  } catch {
    // The browser copy remains.
  }
  return local ? "browser" : "none";
}

const EFFORT_LIMITS = [7, 30, 90, 180];

/** Relative first-load effort from 1 to 5, from the days left to fetch. */
export function loadEffort(daysToFetch: number): number {
  const index = EFFORT_LIMITS.findIndex((limit) => daysToFetch <= limit);
  return index === -1 ? 5 : index + 1;
}
