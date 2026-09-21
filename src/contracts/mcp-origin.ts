export type McpOrigin = "external" | "internal";

export function isMcpOrigin(value: string): value is McpOrigin {
  return value === "external" || value === "internal";
}

const CURSOR_INTERNAL_MCP_SERVERS = new Set(["cursor-ide-browser"]);

export function normalizeMcpServerName(server: string): string {
  return server.trim().toLowerCase();
}

export function parseInternalMcpServers(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "").split(",").map(normalizeMcpServerName).filter(Boolean),
    ),
  ];
}

let configuredInternalMcpServers = new Set<string>();

export function configureInternalMcpServers(value: string | undefined): void {
  configuredInternalMcpServers = new Set(parseInternalMcpServers(value));
}

export function classifyMcpServer(
  server: string,
  internalServers: ReadonlySet<string> = configuredInternalMcpServers,
): McpOrigin {
  const normalized = normalizeMcpServerName(server);
  return CURSOR_INTERNAL_MCP_SERVERS.has(normalized) ||
    internalServers.has(normalized)
    ? "internal"
    : "external";
}

export function isInternalMcpServer(server: string): boolean {
  return classifyMcpServer(server) === "internal";
}
