import type { McpRecord } from "../../contracts/mcp-response";
import type { McpOrigin } from "../../contracts/mcp-origin";

export type TemporalFilterField =
  "dates" | "days" | "weeks" | "months" | "monthYears" | "quarters" | "years";

export const TEMPORAL_FILTER_FIELDS: readonly TemporalFilterField[] = [
  "dates",
  "days",
  "weeks",
  "months",
  "monthYears",
  "quarters",
  "years",
];

export function isTemporalFilterField(
  value: unknown,
): value is TemporalFilterField {
  return TEMPORAL_FILTER_FIELDS.some((field) => field === value);
}

export interface Filters {
  query: string;
  origins: McpOrigin[];
  users: string[];
  servers: string[];
  tools: string[];
  groups: string[];
  dates: string[];
  days: string[];
  weeks: string[];
  months: string[];
  monthYears: string[];
  quarters: string[];
  years: string[];
}

export const NO_GROUP_VALUE = "\0ungrouped";

export function groupValueLabel(value: string): string {
  return value === NO_GROUP_VALUE ? "No group" : value;
}

export const TEMPORAL_FIELD_LABELS: Record<TemporalFilterField, string> = {
  dates: "Date",
  days: "Day of month",
  weeks: "ISO week",
  months: "Month",
  monthYears: "Month-Year",
  quarters: "Quarter",
  years: "Year",
};

const DATE_PARTS_CACHE = new Map<
  string,
  {
    date: string;
    day: string;
    week: string;
    month: string;
    monthYear: string;
    quarter: string;
    year: string;
  }
>();

function dateParts(dateString: string) {
  const cached = DATE_PARTS_CACHE.get(dateString);
  if (cached) return cached;
  const date = new Date(`${dateString}T00:00:00.000Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const monthNumber = String(month + 1).padStart(2, "0");
  const monthName = date.toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  const isoDate = new Date(date);
  const isoDayOfWeek = isoDate.getUTCDay() || 7;
  isoDate.setUTCDate(isoDate.getUTCDate() + 4 - isoDayOfWeek);
  const isoYear = isoDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(
    ((isoDate.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  const parts = {
    date: dateString,
    day: String(date.getUTCDate()).padStart(2, "0"),
    week: `${isoYear}-W${String(week).padStart(2, "0")}`,
    month: monthName,
    monthYear: `${year}-${monthNumber} · ${monthName.slice(0, 3)}`,
    quarter: `${year}-Q${Math.floor(month / 3) + 1}`,
    year: String(year),
  };
  DATE_PARTS_CACHE.set(dateString, parts);
  return parts;
}

export function temporalValue(
  date: string,
  field: TemporalFilterField,
): string {
  const parts = dateParts(date);
  if (field === "dates") return parts.date;
  if (field === "days") return parts.day;
  if (field === "weeks") return parts.week;
  if (field === "months") return parts.month;
  if (field === "monthYears") return parts.monthYear;
  if (field === "quarters") return parts.quarter;
  return parts.year;
}

export function recordMatchesQuery(record: McpRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    record.displayName,
    record.email,
    record.server,
    record.tool,
    ...(record.directoryGroups ?? []),
  ].some((value) => value.toLowerCase().includes(needle));
}
