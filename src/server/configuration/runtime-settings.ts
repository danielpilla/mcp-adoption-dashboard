import {
  DEFAULT_CURSOR_API_LIMITS,
  type CursorApiLimits,
} from "../cursor/cursor-api.js";
import {
  DEFAULT_RANGE_DAYS,
  MAX_DATE_RANGE_DAYS,
} from "../../contracts/date-range-days.js";
import {
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "./server-configuration.js";

// Node timers cannot represent longer delays.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Defaults for every process-safety setting. They are intentionally high so
 * that default settings are never the reason a result is partial; each one
 * is an optional cap that operators can lower.
 */
export const DEFAULT_RUNTIME_SETTINGS = {
  maxEnrichedGroupAssignments:
    DEFAULT_CURSOR_API_LIMITS.maxEnrichedGroupAssignments,
  maxCachedRecords: 100_000_000,
  validationTimeoutMs: 5 * 60_000,
  analyticsTimeoutMs: 2 * 60 * 60_000,
  directoryTimeoutMs: 24 * 60 * 60_000,
  mcpCacheDirectory: ".cache/mcp-activity",
  mcpCacheMaxBytes: DEFAULT_CURSOR_API_LIMITS.maxResponseBytes,
  mcpCacheRefetchDays: 2,
  defaultRangeDays: DEFAULT_RANGE_DAYS,
} as const;

export interface RuntimeSettings {
  cursorApiLimits: CursorApiLimits;
  maxEnrichedGroupAssignments: number;
  maxCachedRecords: number;
  validationTimeoutMs: number;
  analyticsTimeoutMs: number;
  directoryTimeoutMs: number;
  mcpCache: {
    directory: string;
    maxBytes: number;
    refetchDays: number;
  };
  /** Inclusive length of the range pre-selected at startup when none is remembered. */
  defaultRangeDays: number;
}

export type SettingWarning = (setting: string, reason: string) => void;

const warnInvalidSetting: SettingWarning = (setting, reason) =>
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event: "settings.invalid",
      setting,
      reason,
    }),
  );

/**
 * Reads DEFAULT_RANGE_DAYS. This setting only changes the first range the
 * dashboard loads, so an invalid value falls back to the default with a
 * warning instead of stopping the server.
 */
export function parseDefaultRangeDays(
  value: string | undefined,
  warn: SettingWarning = warnInvalidSetting,
): number {
  const raw = value?.trim();
  if (!raw) return DEFAULT_RUNTIME_SETTINGS.defaultRangeDays;
  const parsed = Number(raw);
  if (
    /^\d+$/.test(raw) &&
    Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= MAX_DATE_RANGE_DAYS
  ) {
    return parsed;
  }
  warn(
    "DEFAULT_RANGE_DAYS",
    `DEFAULT_RANGE_DAYS must be an integer from 1 to ${MAX_DATE_RANGE_DAYS}; using ${DEFAULT_RUNTIME_SETTINGS.defaultRangeDays}.`,
  );
  return DEFAULT_RUNTIME_SETTINGS.defaultRangeDays;
}

function parseTimeout(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = parsePositiveInteger(value, fallback, name);
  if (parsed > MAX_TIMER_MS) {
    throw new Error(`${name} must be at most ${MAX_TIMER_MS}.`);
  }
  return parsed;
}

export function readRuntimeSettings(
  env: Record<string, string | undefined>,
  warn: SettingWarning = warnInvalidSetting,
): RuntimeSettings {
  const limit = (name: string, fallback: number) =>
    parsePositiveInteger(env[name], fallback, name);
  return {
    cursorApiLimits: {
      maxRecords: limit(
        "MAX_MCP_RECORDS",
        DEFAULT_CURSOR_API_LIMITS.maxRecords,
      ),
      maxResponseBytes: limit(
        "MAX_MCP_RESPONSE_BYTES",
        DEFAULT_CURSOR_API_LIMITS.maxResponseBytes,
      ),
      maxPageBytes: limit(
        "MAX_API_PAGE_BYTES",
        DEFAULT_CURSOR_API_LIMITS.maxPageBytes,
      ),
      maxDirectoryGroups: limit(
        "MAX_DIRECTORY_GROUPS",
        DEFAULT_CURSOR_API_LIMITS.maxDirectoryGroups,
      ),
      maxGroupMemberships: limit(
        "MAX_GROUP_MEMBERSHIPS",
        DEFAULT_CURSOR_API_LIMITS.maxGroupMemberships,
      ),
    },
    maxEnrichedGroupAssignments: limit(
      "MAX_ENRICHED_GROUP_ASSIGNMENTS",
      DEFAULT_RUNTIME_SETTINGS.maxEnrichedGroupAssignments,
    ),
    maxCachedRecords: limit(
      "MAX_CACHED_RECORDS",
      DEFAULT_RUNTIME_SETTINGS.maxCachedRecords,
    ),
    validationTimeoutMs: parseTimeout(
      env.VALIDATION_TIMEOUT_MS,
      DEFAULT_RUNTIME_SETTINGS.validationTimeoutMs,
      "VALIDATION_TIMEOUT_MS",
    ),
    analyticsTimeoutMs: parseTimeout(
      env.ANALYTICS_TIMEOUT_MS,
      DEFAULT_RUNTIME_SETTINGS.analyticsTimeoutMs,
      "ANALYTICS_TIMEOUT_MS",
    ),
    directoryTimeoutMs: parseTimeout(
      env.DIRECTORY_LOAD_TIMEOUT_MS,
      DEFAULT_RUNTIME_SETTINGS.directoryTimeoutMs,
      "DIRECTORY_LOAD_TIMEOUT_MS",
    ),
    mcpCache: {
      directory:
        env.MCP_CACHE_DIR?.trim() || DEFAULT_RUNTIME_SETTINGS.mcpCacheDirectory,
      maxBytes: limit(
        "MCP_CACHE_MAX_BYTES",
        DEFAULT_RUNTIME_SETTINGS.mcpCacheMaxBytes,
      ),
      refetchDays: parseNonNegativeInteger(
        env.MCP_CACHE_REFETCH_DAYS,
        DEFAULT_RUNTIME_SETTINGS.mcpCacheRefetchDays,
        "MCP_CACHE_REFETCH_DAYS",
      ),
    },
    defaultRangeDays: parseDefaultRangeDays(env.DEFAULT_RANGE_DAYS, warn),
  };
}
