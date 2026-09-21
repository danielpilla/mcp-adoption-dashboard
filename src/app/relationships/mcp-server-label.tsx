import { isInternalMcpServer } from "../../contracts/mcp-origin";

export function McpServerLabel({
  server,
  className = "",
}: {
  server: string;
  className?: string;
}) {
  return (
    <span className={`mcp-server-label ${className}`.trim()}>
      <span className="mcp-server-value">{server}</span>
      {isInternalMcpServer(server) && (
        <span
          className="internal-mcp-badge"
          title="Cursor internal or test MCP traffic"
        >
          Internal
        </span>
      )}
    </span>
  );
}
