import { configureInternalMcpServers } from "../../contracts/mcp-origin";
import {
  parseMcpResponse,
  type McpResponse,
} from "../../contracts/mcp-response";

export function ingestDashboardResponse(value: unknown): McpResponse {
  const response = parseMcpResponse(value);
  configureInternalMcpServers(
    response.records
      .filter((record) => record.origin === "internal")
      .map((record) => record.server)
      .join(","),
  );
  return response;
}
