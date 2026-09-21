import type { McpRecord } from "../../contracts/mcp-response";
import { mcpToolPairKey } from "../../contracts/mcp-tool-pair";

export type DailyMetric = "usage" | "users" | "servers" | "tools";

export function dailySeries(records: McpRecord[], metric: DailyMetric) {
  const buckets = new Map<
    string,
    {
      usage: number;
      users: Set<string>;
      servers: Set<string>;
      tools: Set<string>;
    }
  >();
  for (const record of records) {
    const bucket = buckets.get(record.date) ?? {
      usage: 0,
      users: new Set<string>(),
      servers: new Set<string>(),
      tools: new Set<string>(),
    };
    bucket.usage += record.usage;
    bucket.users.add(record.email);
    bucket.servers.add(record.server);
    bucket.tools.add(mcpToolPairKey(record.server, record.tool));
    buckets.set(record.date, bucket);
  }
  return [...buckets]
    .map(
      ([date, bucket]) =>
        [
          date,
          metric === "usage"
            ? bucket.usage
            : metric === "users"
              ? bucket.users.size
              : metric === "servers"
                ? bucket.servers.size
                : bucket.tools.size,
        ] as [string, number],
    )
    .sort(([a], [b]) => a.localeCompare(b));
}

export function continuousDailySeries(
  records: McpRecord[],
  metric: DailyMetric,
  startDate: string,
  endDate: string,
): Array<[string, number]> {
  const observed = new Map(dailySeries(records, metric));
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start > end
  ) {
    return [...observed];
  }

  const series: Array<[string, number]> = [];
  for (
    const date = new Date(start);
    date <= end;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    const value = date.toISOString().slice(0, 10);
    series.push([value, observed.get(value) ?? 0]);
  }
  return series;
}

export function dailyUsage(records: McpRecord[]) {
  return dailySeries(records, "usage");
}

export function serverUsage(records: McpRecord[]) {
  const totals = new Map<
    string,
    { usage: number; users: Set<string>; tools: Set<string> }
  >();
  for (const record of records) {
    const current = totals.get(record.server) ?? {
      usage: 0,
      users: new Set<string>(),
      tools: new Set<string>(),
    };
    current.usage += record.usage;
    current.users.add(record.email);
    current.tools.add(record.tool);
    totals.set(record.server, current);
  }
  return [...totals]
    .map(([server, value]) => ({
      server,
      usage: value.usage,
      users: value.users.size,
      tools: value.tools.size,
    }))
    .sort((a, b) => b.usage - a.usage || a.server.localeCompare(b.server));
}

export function toolUsage(records: McpRecord[]) {
  const totals = new Map<
    string,
    {
      server: string;
      tool: string;
      usage: number;
      users: Set<string>;
    }
  >();
  for (const record of records) {
    const key = mcpToolPairKey(record.server, record.tool);
    const current = totals.get(key) ?? {
      server: record.server,
      tool: record.tool,
      usage: 0,
      users: new Set<string>(),
    };
    current.usage += record.usage;
    current.users.add(record.email);
    totals.set(key, current);
  }
  return [...totals.values()]
    .map((value) => ({
      server: value.server,
      tool: value.tool,
      usage: value.usage,
      users: value.users.size,
    }))
    .sort(
      (a, b) =>
        b.usage - a.usage ||
        a.server.localeCompare(b.server) ||
        a.tool.localeCompare(b.tool),
    );
}

export function userUsage(records: McpRecord[], server?: string) {
  const totals = new Map<
    string,
    {
      email: string;
      displayName: string;
      usage: number;
      tools: Set<string>;
      directoryGroups: Set<string>;
      lastActive: string;
    }
  >();
  for (const record of records) {
    if (server && record.server !== server) continue;
    const current = totals.get(record.email) ?? {
      email: record.email,
      displayName: record.displayName,
      usage: 0,
      tools: new Set<string>(),
      directoryGroups: new Set<string>(),
      lastActive: record.date,
    };
    current.usage += record.usage;
    current.tools.add(mcpToolPairKey(record.server, record.tool));
    for (const group of record.directoryGroups ?? []) {
      current.directoryGroups.add(group);
    }
    if (record.date > current.lastActive) current.lastActive = record.date;
    totals.set(record.email, current);
  }
  return [...totals.values()]
    .map((value) => ({
      ...value,
      tools: value.tools.size,
      directoryGroups: [...value.directoryGroups].sort(),
    }))
    .sort(
      (a, b) => b.usage - a.usage || a.displayName.localeCompare(b.displayName),
    );
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}
