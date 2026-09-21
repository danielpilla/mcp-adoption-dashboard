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
}

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

export function parseMcpResponse(value: unknown): McpResponse {
  if (!isObject(value) || !Array.isArray(value.records)) {
    throw new Error("Invalid dashboard data: records are missing.");
  }
  const records = value.records.map((record): McpRecord => {
    if (!isMcpRecord(record)) {
      throw new Error(
        "Invalid dashboard data: an activity record is malformed.",
      );
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
  });
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
  };
}

export function summarizeMcpRecords(records: readonly McpRecord[]): McpSummary {
  let totalUsage = 0;
  for (const record of records) {
    totalUsage += record.usage;
    if (!Number.isSafeInteger(totalUsage)) {
      throw new RangeError("MCP usage total exceeds safe integer precision.");
    }
  }
  return {
    totalUsage,
    uniqueUsers: new Set(records.map((record) => record.email)).size,
    uniqueServers: new Set(records.map((record) => record.server)).size,
    uniqueTools: new Set(
      records.map((record) => mcpToolPairKey(record.server, record.tool)),
    ).size,
  };
}
