import type { DateRange, McpRecord } from "../../contracts/mcp-response";
import {
  TEMPORAL_FILTER_FIELDS,
  temporalValue,
  type Filters,
  type TemporalFilterField,
} from "../scope/filter-model";
import { shiftIsoDate } from "../dashboard/dashboard-dates";

type TemporalFilters = Pick<Filters, TemporalFilterField>;

export type McpMomentumPeriod = DateRange & {
  days: number;
};

type McpMomentumItemBase = {
  server: string;
  previousCalls: number;
  currentCalls: number;
  change: number;
};

export type McpMomentumItem = McpMomentumItemBase &
  (
    | { status: "new"; percentageChange: null }
    | {
        status: "changed" | "inactive";
        percentageChange: number;
      }
  );

export type McpMomentumResult =
  | {
      status: "ready";
      previousPeriod: McpMomentumPeriod;
      currentPeriod: McpMomentumPeriod;
      omittedLeadingDate: string | null;
      increased: McpMomentumItem[];
      decreased: McpMomentumItem[];
      unchangedCount: number;
    }
  | {
      status: "insufficient-history" | "disjoint-range";
      availableDays: number;
    };

function calendarDates(range: DateRange): string[] {
  const dates: string[] = [];
  for (
    let date = range.startDate;
    date <= range.endDate;
    date = shiftIsoDate(date, 1)
  ) {
    dates.push(date);
  }
  return dates;
}

function matchesTemporalFilters(
  date: string,
  filters: TemporalFilters,
): boolean {
  return TEMPORAL_FILTER_FIELDS.every(
    (field) =>
      filters[field].length === 0 ||
      filters[field].includes(temporalValue(date, field)),
  );
}

function isContinuous(dates: string[]): boolean {
  return dates.every((date, index) => {
    if (index === 0) return true;
    const previousDate = dates[index - 1];
    return previousDate !== undefined && date === shiftIsoDate(previousDate, 1);
  });
}

function period(dates: string[]): McpMomentumPeriod {
  const startDate = dates[0];
  const endDate = dates.at(-1);
  if (!startDate || !endDate) {
    throw new RangeError("A momentum period requires at least one date.");
  }
  return {
    startDate,
    endDate,
    days: dates.length,
  };
}

function callsByServer(
  records: readonly McpRecord[],
  range: DateRange,
): Map<string, number> {
  const calls = new Map<string, number>();
  for (const record of records) {
    if (record.date < range.startDate || record.date > range.endDate) continue;
    calls.set(record.server, (calls.get(record.server) ?? 0) + record.usage);
  }
  return calls;
}

function compareServers(
  previous: Map<string, number>,
  current: Map<string, number>,
) {
  const increased: McpMomentumItem[] = [];
  const decreased: McpMomentumItem[] = [];
  let unchangedCount = 0;

  for (const server of new Set([...previous.keys(), ...current.keys()])) {
    const previousCalls = previous.get(server) ?? 0;
    const currentCalls = current.get(server) ?? 0;
    const change = currentCalls - previousCalls;
    if (change === 0) {
      unchangedCount += 1;
      continue;
    }
    const baseItem: McpMomentumItemBase = {
      server,
      previousCalls,
      currentCalls,
      change,
    };
    const item: McpMomentumItem =
      previousCalls === 0
        ? { ...baseItem, status: "new", percentageChange: null }
        : {
            ...baseItem,
            status: currentCalls === 0 ? "inactive" : "changed",
            percentageChange: (change / previousCalls) * 100,
          };
    (change > 0 ? increased : decreased).push(item);
  }

  const sortItems = (left: McpMomentumItem, right: McpMomentumItem) =>
    Math.abs(right.change) - Math.abs(left.change) ||
    right.currentCalls - left.currentCalls ||
    left.server.localeCompare(right.server);
  increased.sort(sortItems);
  decreased.sort(sortItems);

  return { increased, decreased, unchangedCount };
}

export function buildMcpMomentum(
  records: readonly McpRecord[],
  activeRange: DateRange,
  temporalFilters: TemporalFilters,
  excludeEndDate = false,
): McpMomentumResult {
  const eligibleDates = calendarDates(activeRange)
    .filter((date) => !excludeEndDate || date !== activeRange.endDate)
    .filter((date) => matchesTemporalFilters(date, temporalFilters));

  if (!isContinuous(eligibleDates)) {
    return {
      status: "disjoint-range",
      availableDays: eligibleDates.length,
    };
  }
  if (eligibleDates.length < 6) {
    return {
      status: "insufficient-history",
      availableDays: eligibleDates.length,
    };
  }

  const omittedLeadingDate =
    eligibleDates.length % 2 === 1 ? (eligibleDates[0] ?? null) : null;
  const comparableDates = omittedLeadingDate
    ? eligibleDates.slice(1)
    : eligibleDates;
  const midpoint = comparableDates.length / 2;
  const previousDates = comparableDates.slice(0, midpoint);
  const currentDates = comparableDates.slice(midpoint);
  const previousPeriod = period(previousDates);
  const currentPeriod = period(currentDates);
  const comparison = compareServers(
    callsByServer(records, previousPeriod),
    callsByServer(records, currentPeriod),
  );

  return {
    status: "ready",
    previousPeriod,
    currentPeriod,
    omittedLeadingDate,
    ...comparison,
  };
}
