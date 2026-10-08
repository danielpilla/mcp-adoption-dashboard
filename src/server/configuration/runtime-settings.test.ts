import { describe, expect, it } from "vitest";
import { readRuntimeSettings } from "./runtime-settings";

describe("runtime settings", () => {
  it("defaults every cap high enough for 100 million records", () => {
    expect(readRuntimeSettings({})).toEqual({
      cursorApiLimits: {
        maxRecords: 100_000_000,
        maxResponseBytes: 25_600_000_000,
        maxPageBytes: 67_108_864,
        maxDirectoryGroups: 1_000_000,
        maxGroupMemberships: 100_000_000,
      },
      maxEnrichedGroupAssignments: 1_000_000_000,
      maxCachedRecords: 100_000_000,
      validationTimeoutMs: 300_000,
      analyticsTimeoutMs: 7_200_000,
      directoryTimeoutMs: 86_400_000,
      mcpCache: {
        directory: ".cache/mcp-activity",
        maxBytes: 25_600_000_000,
        refetchDays: 2,
      },
    });
  });

  it("reads every setting from the environment", () => {
    expect(
      readRuntimeSettings({
        MAX_MCP_RECORDS: "10",
        MAX_MCP_RESPONSE_BYTES: "20",
        MAX_API_PAGE_BYTES: "30",
        MAX_DIRECTORY_GROUPS: "40",
        MAX_GROUP_MEMBERSHIPS: "50",
        MAX_ENRICHED_GROUP_ASSIGNMENTS: "60",
        MAX_CACHED_RECORDS: "70",
        VALIDATION_TIMEOUT_MS: "80",
        ANALYTICS_TIMEOUT_MS: "90",
        DIRECTORY_LOAD_TIMEOUT_MS: "100",
        MCP_CACHE_DIR: " /tmp/mcp-cache ",
        MCP_CACHE_MAX_BYTES: "110",
        MCP_CACHE_REFETCH_DAYS: "0",
      }),
    ).toEqual({
      cursorApiLimits: {
        maxRecords: 10,
        maxResponseBytes: 20,
        maxPageBytes: 30,
        maxDirectoryGroups: 40,
        maxGroupMemberships: 50,
      },
      maxEnrichedGroupAssignments: 60,
      maxCachedRecords: 70,
      validationTimeoutMs: 80,
      analyticsTimeoutMs: 90,
      directoryTimeoutMs: 100,
      mcpCache: { directory: "/tmp/mcp-cache", maxBytes: 110, refetchDays: 0 },
    });
  });

  it.each([
    [
      "MAX_MCP_RECORDS",
      "0",
      "MAX_MCP_RECORDS must be a positive safe integer.",
    ],
    [
      "MCP_CACHE_REFETCH_DAYS",
      "-1",
      "MCP_CACHE_REFETCH_DAYS must be a non-negative safe integer.",
    ],
    [
      "ANALYTICS_TIMEOUT_MS",
      "2147483648",
      "ANALYTICS_TIMEOUT_MS must be at most 2147483647.",
    ],
  ])("rejects an invalid %s", (name, value, message) => {
    expect(() => readRuntimeSettings({ [name]: value })).toThrow(message);
  });
});
