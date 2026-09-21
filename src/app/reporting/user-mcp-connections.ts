import type { McpRecord } from "../../contracts/mcp-response";

export interface UserMcpConnection {
  userId: string;
  email: string;
  displayName: string;
  role?: string;
  directoryGroups: string[];
  server: string;
  firstObserved: string;
  lastObserved: string;
  activeDays: number;
  totalCalls: number;
  tools: string[];
}

export function buildUserMcpConnections(
  records: readonly McpRecord[],
): UserMcpConnection[] {
  const connections = new Map<
    string,
    Omit<UserMcpConnection, "activeDays" | "tools"> & {
      activeDates: Set<string>;
      toolNames: Set<string>;
    }
  >();

  for (const record of records) {
    const key = JSON.stringify([record.email, record.server]);
    const current = connections.get(key) ?? {
      userId: record.userId,
      email: record.email,
      displayName: record.displayName,
      role: record.role,
      directoryGroups: [...(record.directoryGroups ?? [])],
      server: record.server,
      firstObserved: record.date,
      lastObserved: record.date,
      totalCalls: 0,
      activeDates: new Set<string>(),
      toolNames: new Set<string>(),
    };
    current.totalCalls += record.usage;
    current.activeDates.add(record.date);
    current.toolNames.add(record.tool);
    if (record.date < current.firstObserved)
      current.firstObserved = record.date;
    if (record.date > current.lastObserved) current.lastObserved = record.date;
    connections.set(key, current);
  }

  return [...connections.values()]
    .map(({ activeDates, toolNames, ...connection }) => ({
      ...connection,
      activeDays: activeDates.size,
      tools: [...toolNames].sort((a, b) => a.localeCompare(b)),
    }))
    .sort(
      (a, b) =>
        b.lastObserved.localeCompare(a.lastObserved) ||
        b.totalCalls - a.totalCalls ||
        a.displayName.localeCompare(b.displayName) ||
        a.server.localeCompare(b.server),
    );
}
