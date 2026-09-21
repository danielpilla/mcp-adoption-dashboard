const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

// Inclusive ranges are capped to one leap year to bound upstream work.
export const MAX_DATE_RANGE_DAYS = 366;

function parseIsoDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new RangeError(`${field} must use YYYY-MM-DD format`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError(`${field} is not a valid calendar date`);
  }
  return date;
}

export function validateDateRange(
  rawStart: unknown,
  rawEnd: unknown,
  now = new Date(),
): { startDate: string; endDate: string } {
  const start = parseIsoDate(rawStart, "startDate");
  const end = parseIsoDate(rawEnd, "endDate");
  if (start > end) {
    throw new RangeError("startDate must be on or before endDate");
  }
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (end > today) {
    throw new RangeError("endDate cannot be in the future");
  }
  const inclusiveDays =
    Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (inclusiveDays > MAX_DATE_RANGE_DAYS) {
    throw new RangeError(
      `date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`,
    );
  }

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}
