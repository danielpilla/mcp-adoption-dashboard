import type { McpOrigin } from "./mcp-origin.js";
import { mcpToolPairKey } from "./mcp-tool-pair.js";

export interface McpRecord {
  date: string;
  userId: string;
  email: string;
  displayName: string;
  server: string;
  tool: string;
  usage: number;
  origin?: McpOrigin;
  role?: string;
  directoryGroups?: string[];
}

export interface McpSummary {
  totalUsage: number;
  uniqueUsers: number;
  uniqueServers: number;
  uniqueTools: number;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

type McpResponseNoticeCode =
  "LIMIT_REACHED" | "DIRECTORY_LOADING" | "DIRECTORY_UNAVAILABLE";

/**
 * A non-blocking condition attached to a response. LIMIT_REACHED means the
 * response is partial; `completeFrom` is the first date from which activity
 * through the end of the range is complete, when any day is complete.
 */
export interface McpResponseNotice {
  code: McpResponseNoticeCode;
  message: string;
  setting?: string;
  limit?: number;
  completeFrom?: string;
}

export interface McpResponse {
  records: McpRecord[];
  summary: McpSummary;
  range: DateRange;
  generatedAt: string;
  source: "live" | "snapshot";
  team?: {
    id: string;
    name: string;
    memberCount: number;
    groupCount: number;
  };
  notices?: McpResponseNotice[];
}

const NOTICE_CODES: ReadonlySet<string> = new Set<McpResponseNoticeCode>([
  "LIMIT_REACHED",
  "DIRECTORY_LOADING",
  "DIRECTORY_UNAVAILABLE",
]);
const MAX_NOTICES = 20;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value) && value.every((item) => isText(item, maxLength));
}

function isText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    !value.includes("\0")
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMcpRecord(value: unknown): value is McpRecord {
  if (!isObject(value)) return false;
  return (
    isIsoDate(value.date) &&
    isText(value.userId, 512) &&
    isText(value.email, 320) &&
    isText(value.displayName, 512) &&
    isText(value.server, 512) &&
    isText(value.tool, 512) &&
    typeof value.usage === "number" &&
    Number.isSafeInteger(value.usage) &&
    Number(value.usage) > 0 &&
    (value.origin === undefined ||
      value.origin === "external" ||
      value.origin === "internal") &&
    (value.role === undefined || isText(value.role, 128)) &&
    (value.directoryGroups === undefined ||
      isStringArray(value.directoryGroups, 512))
  );
}

/** Validates one activity record and strips unknown fields. */
export function parseMcpRecord(record: unknown): McpRecord {
  if (!isMcpRecord(record)) {
    throw new Error("Invalid dashboard data: an activity record is malformed.");
  }
  return {
    date: record.date,
    userId: record.userId,
    email: record.email,
    displayName: record.displayName,
    server: record.server,
    tool: record.tool,
    usage: record.usage,
    ...(record.origin ? { origin: record.origin } : {}),
    ...(record.role !== undefined ? { role: record.role } : {}),
    ...(record.directoryGroups
      ? { directoryGroups: [...record.directoryGroups] }
      : {}),
  };
}

function parseNotice(value: unknown): McpResponseNotice {
  if (
    !isObject(value) ||
    typeof value.code !== "string" ||
    !NOTICE_CODES.has(value.code) ||
    !isText(value.message, 1_000) ||
    (value.setting !== undefined &&
      (typeof value.setting !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.setting))) ||
    (value.limit !== undefined && !isNonNegativeSafeInteger(value.limit)) ||
    (value.completeFrom !== undefined && !isIsoDate(value.completeFrom))
  ) {
    throw new Error("Invalid dashboard data: a notice is malformed.");
  }
  return {
    code: value.code as McpResponseNoticeCode,
    message: value.message,
    ...(value.setting !== undefined ? { setting: value.setting } : {}),
    ...(value.limit !== undefined ? { limit: value.limit } : {}),
    ...(value.completeFrom !== undefined
      ? { completeFrom: value.completeFrom }
      : {}),
  };
}

export function parseMcpResponse(value: unknown): McpResponse {
  if (!isObject(value) || !Array.isArray(value.records)) {
    throw new Error("Invalid dashboard data: records are missing.");
  }
  const records = value.records.map(parseMcpRecord);
  if (!isObject(value.range)) {
    throw new Error("Invalid dashboard data: date range is missing.");
  }
  const { startDate, endDate } = value.range;
  if (
    !isIsoDate(startDate) ||
    !isIsoDate(endDate) ||
    startDate > endDate ||
    records.some((record) => record.date < startDate || record.date > endDate)
  ) {
    throw new Error("Invalid dashboard data: date range is malformed.");
  }
  if (
    !isText(value.generatedAt, 128) ||
    Number.isNaN(Date.parse(value.generatedAt)) ||
    (value.source !== "live" && value.source !== "snapshot")
  ) {
    throw new Error("Invalid dashboard data: provenance is malformed.");
  }
  if (!isObject(value.summary)) {
    throw new Error("Invalid dashboard data: summary is missing.");
  }
  const expected = summarizeMcpRecords(records);
  if (
    !isNonNegativeSafeInteger(value.summary.totalUsage) ||
    !isNonNegativeSafeInteger(value.summary.uniqueUsers) ||
    !isNonNegativeSafeInteger(value.summary.uniqueServers) ||
    !isNonNegativeSafeInteger(value.summary.uniqueTools) ||
    value.summary.totalUsage !== expected.totalUsage ||
    value.summary.uniqueUsers !== expected.uniqueUsers ||
    value.summary.uniqueServers !== expected.uniqueServers ||
    value.summary.uniqueTools !== expected.uniqueTools
  ) {
    throw new Error("Invalid dashboard data: summary does not match records.");
  }
  let team: McpResponse["team"];
  if (value.team !== undefined) {
    if (
      !isObject(value.team) ||
      !isText(value.team.id, 512) ||
      !isText(value.team.name, 512) ||
      !isNonNegativeSafeInteger(value.team.memberCount) ||
      !isNonNegativeSafeInteger(value.team.groupCount)
    ) {
      throw new Error("Invalid dashboard data: team metadata is malformed.");
    }
    team = {
      id: value.team.id,
      name: value.team.name,
      memberCount: value.team.memberCount,
      groupCount: value.team.groupCount,
    };
  }
  let notices: McpResponseNotice[] | undefined;
  if (value.notices !== undefined) {
    if (!Array.isArray(value.notices) || value.notices.length > MAX_NOTICES) {
      throw new Error("Invalid dashboard data: notices are malformed.");
    }
    notices = value.notices.map(parseNotice);
  }
  return {
    records,
    summary: {
      totalUsage: value.summary.totalUsage,
      uniqueUsers: value.summary.uniqueUsers,
      uniqueServers: value.summary.uniqueServers,
      uniqueTools: value.summary.uniqueTools,
    },
    range: { startDate, endDate },
    generatedAt: value.generatedAt,
    source: value.source,
    ...(team ? { team } : {}),
    ...(notices && notices.length > 0 ? { notices } : {}),
  };
}

/**
 * Accumulates a summary one record at a time so large results can be
 * summarized while they are streamed instead of after they are buffered.
 */
export class McpSummaryAccumulator {
  private totalUsage = 0;
  private readonly users = new Set<string>();
  private readonly servers = new Set<string>();
  private readonly tools = new Set<string>();

  add(record: McpRecord): void {
    this.totalUsage += record.usage;
    if (!Number.isSafeInteger(this.totalUsage)) {
      throw new RangeError("MCP usage total exceeds safe integer precision.");
    }
    this.users.add(record.email);
    this.servers.add(record.server);
    this.tools.add(mcpToolPairKey(record.server, record.tool));
  }

  result(): McpSummary {
    return {
      totalUsage: this.totalUsage,
      uniqueUsers: this.users.size,
      uniqueServers: this.servers.size,
      uniqueTools: this.tools.size,
    };
  }
}

export function summarizeMcpRecords(records: readonly McpRecord[]): McpSummary {
  const summary = new McpSummaryAccumulator();
  for (const record of records) summary.add(record);
  return summary.result();
}
