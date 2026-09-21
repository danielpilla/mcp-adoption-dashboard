import {
  summarizeMcpRecords,
  type DateRange,
  type McpRecord,
  type McpSummary,
} from "../../contracts/mcp-response";
import { shiftIsoDate } from "../dashboard/dashboard-dates";

export type WeeklyComparison = {
  current: McpSummary;
  previous: McpSummary;
  calls: number | null;
  users: number;
  servers: number;
  tools: number;
};

export function buildWeeklyComparison(
  records: readonly McpRecord[],
  activeRange: DateRange,
  sourceRange: DateRange,
  excludeEndDate = false,
): WeeklyComparison | null {
  const currentEnd = excludeEndDate
    ? shiftIsoDate(activeRange.endDate, -1)
    : activeRange.endDate;
  const currentStart = shiftIsoDate(currentEnd, -6);
  const previousEnd = shiftIsoDate(currentEnd, -7);
  const previousStart = shiftIsoDate(currentEnd, -13);

  if (
    sourceRange.startDate > previousStart ||
    sourceRange.endDate < currentEnd
  ) {
    return null;
  }

  const current = summarizeMcpRecords(
    records.filter(
      (record) => record.date >= currentStart && record.date <= currentEnd,
    ),
  );
  const previous = summarizeMcpRecords(
    records.filter(
      (record) => record.date >= previousStart && record.date <= previousEnd,
    ),
  );

  return {
    current,
    previous,
    calls:
      previous.totalUsage > 0
        ? Math.round(
            ((current.totalUsage - previous.totalUsage) / previous.totalUsage) *
              100,
          )
        : null,
    users: current.uniqueUsers - previous.uniqueUsers,
    servers: current.uniqueServers - previous.uniqueServers,
    tools: current.uniqueTools - previous.uniqueTools,
  };
}
