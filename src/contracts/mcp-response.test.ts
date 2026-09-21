import { afterEach, describe, expect, it } from "vitest";
import { classifyMcpServer, configureInternalMcpServers } from "./mcp-origin";
import { parseMcpResponse } from "./mcp-response";

const response = {
  records: [
    {
      date: "2026-09-20",
      userId: "user-1",
      email: "user@example.com",
      displayName: "Example User",
      server: "example",
      tool: "search",
      usage: 3,
    },
  ],
  summary: {
    totalUsage: 3,
    uniqueUsers: 1,
    uniqueServers: 1,
    uniqueTools: 1,
  },
  range: {
    startDate: "2026-09-20",
    endDate: "2026-09-20",
  },
  generatedAt: "2026-09-20T12:00:00.000Z",
  source: "live",
} as const;

afterEach(() => {
  configureInternalMcpServers(undefined);
});

describe("dashboard response validation", () => {
  it("accepts a coherent response", () => {
    expect(parseMcpResponse(response)).toEqual(response);
  });

  it("rejects summaries that do not match the records", () => {
    expect(() =>
      parseMcpResponse({
        ...response,
        summary: { ...response.summary, totalUsage: 0 },
      }),
    ).toThrow("summary does not match records");
  });

  it("rejects activity outside the declared range", () => {
    expect(() =>
      parseMcpResponse({
        ...response,
        range: {
          startDate: "2026-09-01",
          endDate: "2026-09-19",
        },
      }),
    ).toThrow("date range is malformed");
  });

  it("rejects zero-usage and control-character records", () => {
    expect(() =>
      parseMcpResponse({
        ...response,
        records: [{ ...response.records[0], usage: 0 }],
        summary: { ...response.summary, totalUsage: 0 },
      }),
    ).toThrow("activity record is malformed");
    expect(() =>
      parseMcpResponse({
        ...response,
        records: [{ ...response.records[0], server: "a\0b" }],
      }),
    ).toThrow("activity record is malformed");
  });

  it("rejects oversized record text at the client boundary", () => {
    expect(() =>
      parseMcpResponse({
        ...response,
        records: [{ ...response.records[0], server: "s".repeat(513) }],
      }),
    ).toThrow("activity record is malformed");
    expect(() =>
      parseMcpResponse({
        ...response,
        records: [
          {
            ...response.records[0],
            directoryGroups: ["g".repeat(513)],
          },
        ],
      }),
    ).toThrow("activity record is malformed");
  });

  it("rejects aggregate totals beyond safe integer precision", () => {
    const usage = Number.MAX_SAFE_INTEGER;
    expect(() =>
      parseMcpResponse({
        ...response,
        records: [
          { ...response.records[0], usage },
          {
            ...response.records[0],
            tool: "second",
            usage: 1,
          },
        ],
        summary: {
          totalUsage: usage + 1,
          uniqueUsers: 1,
          uniqueServers: 1,
          uniqueTools: 2,
        },
      }),
    ).toThrow("safe integer precision");
  });

  it("strips unvalidated snapshot provenance extensions", () => {
    const parsed = parseMcpResponse({
      ...response,
      source: "snapshot",
      snapshotScope: { source: "malformed" },
    });

    expect(parsed).not.toHaveProperty("snapshotScope");
  });

  it("strips legacy record fields outside the public contract", () => {
    const parsed = parseMcpResponse({
      ...response,
      records: [
        {
          ...response.records[0],
          groups: ["Legacy group"],
          unknownField: "ignored",
        },
      ],
    });

    expect(parsed.records[0]).not.toHaveProperty("groups");
    expect(parsed.records[0]).not.toHaveProperty("unknownField");
  });

  it("does not mutate MCP classification while validating data", () => {
    configureInternalMcpServers("configured-internal");

    parseMcpResponse({
      ...response,
      records: [
        {
          ...response.records[0],
          server: "payload-internal",
          origin: "internal",
        },
      ],
    });

    expect(classifyMcpServer("configured-internal")).toBe("internal");
    expect(classifyMcpServer("payload-internal")).toBe("external");
  });
});
