import { describe, expect, it, vi } from "vitest";
import { parseDefaultRangeDays, readRuntimeSettings } from "./runtime-settings";

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
      defaultRangeDays: 90,
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
        DEFAULT_RANGE_DAYS: "14",
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
      defaultRangeDays: 14,
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

  describe("DEFAULT_RANGE_DAYS", () => {
    it.each([
      [undefined, 90],
      ["", 90],
      ["   ", 90],
    ])("defaults to 90 days for %j without a warning", (value, expected) => {
      const warn = vi.fn();
      expect(parseDefaultRangeDays(value, warn)).toBe(expected);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ["1", 1],
      ["14", 14],
      [" 30 ", 30],
      ["366", 366],
    ])("accepts %j", (value, expected) => {
      const warn = vi.fn();
      expect(parseDefaultRangeDays(value, warn)).toBe(expected);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(["0", "367", "100000000000000000000", "-7", "abc", "14.5", "1e2"])(
      "falls back to 90 days with a warning for %j",
      (value) => {
        const warn = vi.fn();
        expect(parseDefaultRangeDays(value, warn)).toBe(90);
        expect(warn).toHaveBeenCalledWith(
          "DEFAULT_RANGE_DAYS",
          "DEFAULT_RANGE_DAYS must be an integer from 1 to 366; using 90.",
        );
      },
    );

    it("keeps reading the other settings when the value is invalid", () => {
      const warn = vi.fn();
      const settings = readRuntimeSettings(
        { DEFAULT_RANGE_DAYS: "not-a-number", MAX_MCP_RECORDS: "10" },
        warn,
      );
      expect(settings.defaultRangeDays).toBe(90);
      expect(settings.cursorApiLimits.maxRecords).toBe(10);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("writes a structured warning by default", () => {
      const consoleWarn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      try {
        expect(parseDefaultRangeDays("0")).toBe(90);
        expect(consoleWarn).toHaveBeenCalledTimes(1);
        expect(
          JSON.parse(String(consoleWarn.mock.calls[0]?.[0])),
        ).toMatchObject({
          level: "warn",
          event: "settings.invalid",
          setting: "DEFAULT_RANGE_DAYS",
        });
      } finally {
        consoleWarn.mockRestore();
      }
    });
  });
});
