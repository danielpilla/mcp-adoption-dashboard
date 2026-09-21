import type { DateRange } from "../../contracts/mcp-response";

const UTC_MIDNIGHT_SUFFIX = "T00:00:00.000Z";
const DAY_MS = 86_400_000;

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string): Date {
  return new Date(`${value}${UTC_MIDNIGHT_SUFFIX}`);
}

export function shiftIsoDate(value: string, days: number): string {
  const date = parseIsoDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

export function inclusiveDayCount(range: DateRange): number {
  return (
    Math.floor(
      (parseIsoDate(range.endDate).getTime() -
        parseIsoDate(range.startDate).getTime()) /
        DAY_MS,
    ) + 1
  );
}

export function formatIsoDate(
  value: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone: "UTC",
  }).format(parseIsoDate(value));
}

export function presetRange(days: number): DateRange {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - days + 1);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

export function rangeLabel(startDate: string, endDate: string): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  return `${formatIsoDate(startDate, options)} – ${formatIsoDate(endDate, options)}`;
}
