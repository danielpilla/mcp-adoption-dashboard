// Inclusive ranges are capped to one leap year to bound upstream work.
export const MAX_DATE_RANGE_DAYS = 366;

// Inclusive length of the range the dashboard loads first.
export const DEFAULT_RANGE_DAYS = 90;

export function isRangeDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_DATE_RANGE_DAYS
  );
}
