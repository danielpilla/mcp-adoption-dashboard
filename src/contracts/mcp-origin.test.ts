import { describe, expect, it } from "vitest";
import {
  classifyMcpServer,
  configureInternalMcpServers,
  normalizeMcpServerName,
  parseInternalMcpServers,
} from "./mcp-origin";

describe("MCP origin classification", () => {
  it("always classifies Cursor-managed MCPs as internal", () => {
    configureInternalMcpServers(undefined);

    expect(classifyMcpServer("cursor-ide-browser")).toBe("internal");
    expect(classifyMcpServer("  Cursor-IDE-Browser  ")).toBe("internal");
  });

  it("uses deployer-provided internal MCP labels", () => {
    configureInternalMcpServers("example-internal-mcp, example-control-plane");

    expect(classifyMcpServer("example-internal-mcp")).toBe("internal");
    expect(classifyMcpServer("example-control-plane")).toBe("internal");
  });

  it("normalizes whitespace and case before exact matching", () => {
    expect(normalizeMcpServerName("  Example-Internal-MCP  ")).toBe(
      "example-internal-mcp",
    );
    expect(parseInternalMcpServers(" Example-Internal-MCP ")).toEqual([
      "example-internal-mcp",
    ]);
    configureInternalMcpServers("example-internal-mcp");
    expect(classifyMcpServer("  Example-Internal-MCP  ")).toBe("internal");
  });

  it("does not apply prefix matching", () => {
    configureInternalMcpServers("example-internal-mcp");
    expect(classifyMcpServer("example-internal-mcp-custom")).toBe("external");
    expect(classifyMcpServer("playwright")).toBe("external");
  });
});
