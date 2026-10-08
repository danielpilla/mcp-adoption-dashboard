import type {
  DateRange,
  McpRecord,
  McpResponseNotice,
} from "../../contracts/mcp-response.js";

const DAY_MS = 86_400_000;

export interface DayStats {
  records: number;
  bytes: number;
}

/** One included day; `limit` keeps only the first records in sorted order. */
export interface DayPlan {
  date: string;
  limit?: number;
}

export interface McpDayData {
  date: string;
  records: McpRecord[];
}

export interface McpDatasetInfo {
  range: DateRange;
  generatedAt: string;
  team?: { id: string; name: string };
  notices: McpResponseNotice[];
}

/**
 * A completed analytics result that can be read one day at a time. Datasets
 * are reference counted: the creator owns one reference, and each reader
 * acquires another so backing storage outlives every in-progress read.
 */
export interface McpDataset extends McpDatasetInfo {
  recordCount: number;
  readDays(order: "ascending" | "descending"): AsyncGenerator<McpDayData>;
  acquire(): void;
  release(): void;
}

/**
 * Storage for one analytics collection. Pages are staged as they arrive,
 * completed windows are sealed per day, and the planned days become a dataset.
 */
export interface McpRun {
  adoptCachedDays(dates: readonly string[]): Promise<Map<string, DayStats>>;
  write(records: readonly McpRecord[]): Promise<void>;
  sealWindow(
    dates: readonly string[],
    complete: boolean,
  ): Promise<Map<string, DayStats>>;
  countWithinBytes(
    date: string,
    maxRecords: number,
    maxBytes: number,
  ): Promise<number>;
  createDataset(days: DayPlan[], info: McpDatasetInfo): McpDataset;
  discard(): Promise<void>;
}

export interface McpRunFactory {
  beginRun(): Promise<McpRun>;
}

export type ActivityLimitReason = "records" | "bytes" | "page" | "timeout";

const ACTIVITY_LIMIT_SETTINGS: Record<ActivityLimitReason, string> = {
  records: "MAX_MCP_RECORDS",
  bytes: "MAX_MCP_RESPONSE_BYTES",
  page: "MAX_API_PAGE_BYTES",
  timeout: "ANALYTICS_TIMEOUT_MS",
};

export function recordBytes(record: McpRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
}

function compareRecordsWithinDay(a: McpRecord, b: McpRecord): number {
  return (
    a.server.localeCompare(b.server) ||
    a.email.localeCompare(b.email) ||
    a.tool.localeCompare(b.tool)
  );
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function limitDescription(reason: ActivityLimitReason, limit: number): string {
  switch (reason) {
    case "records":
      return `the ${formatCount(limit)}-record limit`;
    case "bytes":
      return `the ${formatCount(limit)}-byte response limit`;
    case "page":
      return `the ${formatCount(limit)}-byte page limit`;
    case "timeout":
      return `the ${formatCount(limit)} ms analytics time limit`;
  }
}

export function activityLimitNotice(
  reason: ActivityLimitReason,
  limit: number,
  range: DateRange,
  completeFrom: string | undefined,
): McpResponseNotice {
  const setting = ACTIVITY_LIMIT_SETTINGS[reason];
  const coverage = completeFrom
    ? `Activity from ${completeFrom} through ${range.endDate} is complete; earlier days are partial or missing.`
    : "No day in this range is complete.";
  const shorter = completeFrom
    ? `a range starting on or after ${completeFrom}`
    : "a shorter date range";
  return {
    code: "LIMIT_REACHED",
    message: `Showing partial activity: ${limitDescription(reason, limit)} (${setting}) was reached. ${coverage} Raise ${setting} or choose ${shorter} for a complete result.`,
    setting,
    limit,
    ...(completeFrom ? { completeFrom } : {}),
  };
}

type SegmentStatus =
  "pending" | "running" | "complete" | "truncated" | "abandoned";

export interface CollectionSegment {
  kind: "cached" | "fetch";
  startDate: string;
  endDate: string;
  /** Dates in the segment, newest first. */
  dates: string[];
  status: SegmentStatus;
  /** Upstream metrics processed, including zero-usage metrics. */
  processed: number;
  bytes: number;
  reason?: ActivityLimitReason;
  days: Map<string, DayStats>;
}

/**
 * Orders a range newest first. Each valid cached day is its own complete
 * segment; contiguous uncached days become fetch windows of at most
 * `windowDays`, aligned to the newest day of each uncached run.
 */
export function buildSegments(
  dates: readonly string[],
  cached: ReadonlyMap<string, DayStats>,
  windowDays: number,
): CollectionSegment[] {
  const segments: CollectionSegment[] = [];
  let window: string[] = [];
  const flush = () => {
    if (window.length === 0) return;
    segments.push({
      kind: "fetch",
      startDate: window[window.length - 1] ?? "",
      endDate: window[0] ?? "",
      dates: window,
      status: "pending",
      processed: 0,
      bytes: 0,
      days: new Map(),
    });
    window = [];
  };
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    const date = dates[index];
    if (date === undefined) continue;
    const stats = cached.get(date);
    if (stats) {
      flush();
      segments.push({
        kind: "cached",
        startDate: date,
        endDate: date,
        dates: [date],
        status: "complete",
        processed: stats.records,
        bytes: stats.bytes,
        days: new Map([[date, stats]]),
      });
      continue;
    }
    window.push(date);
    if (window.length >= windowDays) flush();
  }
  flush();
  return segments;
}

export interface IncludedPlan {
  days: Array<DayPlan & { maxBytes?: number }>;
  limit?: {
    reason: ActivityLimitReason;
    completeFrom?: string;
  };
}

/**
 * Walks segments newest first and keeps every complete segment that fits the
 * record and byte caps. The first segment that is partial or does not fit is
 * included day by day, newest first, up to the remaining capacity, and the
 * walk stops there so the newest data is always the complete part.
 */
export function planIncludedDays(
  segments: readonly CollectionSegment[],
  limits: { maxRecords: number; maxBytes: number },
): IncludedPlan {
  let remainingRecords = limits.maxRecords;
  let remainingBytes = limits.maxBytes;
  const days: IncludedPlan["days"] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    const fits =
      segment.processed <= remainingRecords && segment.bytes <= remainingBytes;
    if (segment.status === "complete" && fits) {
      for (const date of segment.dates) days.push({ date });
      remainingRecords -= segment.processed;
      remainingBytes -= segment.bytes;
      continue;
    }
    let reason: ActivityLimitReason;
    if (segment.status === "complete") {
      reason = segment.processed > remainingRecords ? "records" : "bytes";
    } else {
      reason = segment.reason ?? "records";
    }
    for (const date of segment.dates) {
      if (remainingRecords <= 0 || remainingBytes <= 0) break;
      const stats = segment.days.get(date);
      if (!stats || stats.records === 0) continue;
      if (stats.records <= remainingRecords && stats.bytes <= remainingBytes) {
        days.push({ date });
        remainingRecords -= stats.records;
        remainingBytes -= stats.bytes;
        continue;
      }
      days.push({
        date,
        limit: Math.min(stats.records, remainingRecords),
        maxBytes: remainingBytes,
      });
      remainingRecords = 0;
      remainingBytes = 0;
    }
    const newer = segments[index - 1];
    return {
      days,
      limit: {
        reason,
        ...(newer ? { completeFrom: newer.startDate } : {}),
      },
    };
  }
  return { days };
}

/** Keeps sealed records per day in memory for results without a disk cache. */
export class MemoryMcpRun implements McpRun {
  private readonly staged = new Map<string, McpRecord[]>();
  private readonly sealed = new Map<string, McpRecord[]>();

  async adoptCachedDays(): Promise<Map<string, DayStats>> {
    return new Map();
  }

  async write(records: readonly McpRecord[]): Promise<void> {
    for (const record of records) {
      const day = this.staged.get(record.date);
      if (day) day.push(record);
      else this.staged.set(record.date, [record]);
    }
  }

  async sealWindow(dates: readonly string[]): Promise<Map<string, DayStats>> {
    const stats = new Map<string, DayStats>();
    for (const date of dates) {
      const records = sortDayRecords(this.staged.get(date) ?? []);
      this.staged.delete(date);
      this.sealed.set(date, records);
      stats.set(date, {
        records: records.length,
        bytes: records.reduce(
          (total, record) => total + recordBytes(record),
          0,
        ),
      });
    }
    return stats;
  }

  async countWithinBytes(
    date: string,
    maxRecords: number,
    maxBytes: number,
  ): Promise<number> {
    return countRecordsWithinBytes(
      this.sealed.get(date) ?? [],
      maxRecords,
      maxBytes,
    );
  }

  createDataset(days: DayPlan[], info: McpDatasetInfo): McpDataset {
    const included = days.map(({ date, limit }) => {
      const records = this.sealed.get(date) ?? [];
      return {
        date,
        records: limit === undefined ? records : records.slice(0, limit),
      };
    });
    this.staged.clear();
    this.sealed.clear();
    return createMemoryDataset(included, info);
  }

  async discard(): Promise<void> {
    this.staged.clear();
    this.sealed.clear();
  }
}

export function countRecordsWithinBytes(
  records: readonly McpRecord[],
  maxRecords: number,
  maxBytes: number,
): number {
  let bytes = 0;
  let count = 0;
  for (const record of records) {
    if (count >= maxRecords) break;
    bytes += recordBytes(record);
    if (bytes > maxBytes) break;
    count += 1;
  }
  return count;
}

/**
 * Sorts one day and rejects repeated user, MCP, and tool rows. Pages are
 * validated individually, so this is where duplicates spanning pages surface.
 */
export function sortDayRecords(records: McpRecord[]): McpRecord[] {
  records.sort(compareRecordsWithinDay);
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (
      previous &&
      current &&
      compareRecordsWithinDay(previous, current) === 0
    ) {
      throw new DuplicateMetricError();
    }
  }
  return records;
}

export class DuplicateMetricError extends Error {
  constructor() {
    super("Cursor API returned a duplicate MCP metric");
    this.name = "DuplicateMetricError";
  }
}

export function createMemoryDataset(
  days: McpDayData[],
  info: McpDatasetInfo,
): McpDataset {
  const ordered = days
    .filter((day) => day.records.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    ...info,
    recordCount: ordered.reduce((total, day) => total + day.records.length, 0),
    async *readDays(order) {
      const sequence = order === "ascending" ? ordered : [...ordered].reverse();
      for (const day of sequence) yield day;
    },
    acquire() {},
    release() {},
  };
}
