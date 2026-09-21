// Tool names are only unique within an MCP server, so pair identity must
// preserve both labels everywhere distinct MCP/tool combinations are counted.
export function mcpToolPairKey(server: string, tool: string): string {
  return JSON.stringify([server, tool]);
}
