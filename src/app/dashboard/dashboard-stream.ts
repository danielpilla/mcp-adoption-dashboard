import type { McpResponse } from "../../contracts/mcp-response";
import { ingestDashboardResponse } from "./dashboard-response";
import { isJsonObject } from "./dashboard-api-client";

type DirectoryLoadStatus = "disabled" | "idle" | "loading" | "ready" | "failed";

export interface DirectoryLoadProgress {
  status: DirectoryLoadStatus;
  completedGroups: number;
  /** Null until the number of groups is known. */
  totalGroups: number | null;
}

interface ActivityWindowProgress {
  startDate: string;
  endDate: string;
  days: number;
  pagesLoaded: number;
  /** Null until the upstream reports a page count. */
  totalPages: number | null;
}

interface ActivityRetryProgress {
  /** The attempt that runs after the wait, starting at 2. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** How long the request has waited so far. */
  waitedMs: number;
  reason: "rate_limited" | "server_error" | "network_error";
  status: number | null;
}

/** Day-level progress of the activity load. */
export interface ActivityLoadProgress {
  state: "loading" | "reused" | "ready";
  totalDays: number;
  /** Days served from the per-day cache. */
  cachedDays: number;
  /** Days in fetch windows that finished. */
  fetchedDays: number;
  /** Activity rows loaded so far. */
  records: number;
  completedWindows: number;
  totalWindows: number;
  /** Windows being fetched now, newest first. */
  windows: ActivityWindowProgress[];
  retry: ActivityRetryProgress | null;
  elapsedMs: number;
  /** Time since the last page or window finished. */
  idleMs: number;
}

export interface DashboardLoadProgress {
  completed: number;
  total: number;
  label: string;
  detail: string;
  directory?: DirectoryLoadProgress;
  activity?: ActivityLoadProgress;
  /** Client time when this progress arrived, in epoch milliseconds. */
  receivedAt?: number;
}

export class DashboardSetupRequiredError extends Error {
  readonly code = "SETUP_REQUIRED";
}

const DIRECTORY_STATUSES = new Set<string>([
  "disabled",
  "idle",
  "loading",
  "ready",
  "failed",
]);

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseDirectoryProgress(
  value: unknown,
): DirectoryLoadProgress | undefined {
  if (
    !isJsonObject(value) ||
    typeof value.status !== "string" ||
    !DIRECTORY_STATUSES.has(value.status) ||
    !isCount(value.completedGroups) ||
    (value.totalGroups !== null && !isCount(value.totalGroups))
  ) {
    return undefined;
  }
  return {
    status: value.status as DirectoryLoadStatus,
    completedGroups: value.completedGroups,
    totalGroups: value.totalGroups,
  };
}

const ACTIVITY_STATES = new Set<string>(["loading", "reused", "ready"]);
const RETRY_REASONS = new Set<string>([
  "rate_limited",
  "server_error",
  "network_error",
]);
const MAX_ACTIVE_WINDOWS = 64;

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseWindow(value: unknown): ActivityWindowProgress | undefined {
  if (
    !isJsonObject(value) ||
    !isIsoDate(value.startDate) ||
    !isIsoDate(value.endDate) ||
    !isCount(value.days) ||
    !isCount(value.pagesLoaded) ||
    (value.totalPages !== null && !isCount(value.totalPages))
  ) {
    return undefined;
  }
  return {
    startDate: value.startDate,
    endDate: value.endDate,
    days: value.days,
    pagesLoaded: value.pagesLoaded,
    totalPages: value.totalPages,
  };
}

function parseRetry(value: unknown): ActivityRetryProgress | null | undefined {
  if (value === null) return null;
  if (
    !isJsonObject(value) ||
    !isCount(value.attempt) ||
    !isCount(value.maxAttempts) ||
    !isCount(value.delayMs) ||
    !isCount(value.waitedMs) ||
    typeof value.reason !== "string" ||
    !RETRY_REASONS.has(value.reason) ||
    (value.status !== null && !isCount(value.status))
  ) {
    return undefined;
  }
  return {
    attempt: value.attempt,
    maxAttempts: value.maxAttempts,
    delayMs: value.delayMs,
    waitedMs: value.waitedMs,
    reason: value.reason as ActivityRetryProgress["reason"],
    status: value.status,
  };
}

/** Validates the `activity` object of a progress event, or returns undefined. */
function parseActivityProgress(
  value: unknown,
): ActivityLoadProgress | undefined {
  if (
    !isJsonObject(value) ||
    typeof value.state !== "string" ||
    !ACTIVITY_STATES.has(value.state) ||
    !isCount(value.totalDays) ||
    !isCount(value.cachedDays) ||
    !isCount(value.fetchedDays) ||
    !isCount(value.records) ||
    !isCount(value.completedWindows) ||
    !isCount(value.totalWindows) ||
    !isCount(value.elapsedMs) ||
    !isCount(value.idleMs) ||
    !Array.isArray(value.windows) ||
    value.windows.length > MAX_ACTIVE_WINDOWS
  ) {
    return undefined;
  }
  const windows: ActivityWindowProgress[] = [];
  for (const item of value.windows) {
    const window = parseWindow(item);
    if (!window) return undefined;
    windows.push(window);
  }
  const retry = parseRetry(value.retry);
  if (retry === undefined) return undefined;
  return {
    state: value.state as ActivityLoadProgress["state"],
    totalDays: value.totalDays,
    cachedDays: Math.min(value.cachedDays, value.totalDays),
    fetchedDays: Math.min(
      value.fetchedDays,
      Math.max(0, value.totalDays - value.cachedDays),
    ),
    records: value.records,
    completedWindows: value.completedWindows,
    totalWindows: value.totalWindows,
    windows,
    retry,
    elapsedMs: value.elapsedMs,
    idleMs: value.idleMs,
  };
}

function handleDashboardEvent(
  line: string,
  records: unknown[],
  onProgress: (progress: DashboardLoadProgress) => void,
): McpResponse | null {
  if (!line.trim()) return null;
  const event: unknown = JSON.parse(line);
  if (!isJsonObject(event)) {
    throw new Error("The local server returned an invalid event.");
  }
  if (event.type === "progress") {
    if (
      typeof event.completed !== "number" ||
      typeof event.total !== "number" ||
      typeof event.label !== "string" ||
      typeof event.detail !== "string"
    ) {
      throw new Error("The local server returned invalid progress.");
    }
    const directory = parseDirectoryProgress(event.directory);
    const activity = parseActivityProgress(event.activity);
    onProgress({
      completed: event.completed,
      total: event.total,
      label: event.label,
      detail: event.detail,
      ...(directory ? { directory } : {}),
      ...(activity ? { activity } : {}),
    });
    return null;
  }
  if (event.type === "records") {
    if (!Array.isArray(event.records)) {
      throw new Error("The local server returned invalid records.");
    }
    for (const record of event.records) records.push(record);
    return null;
  }
  if (event.type === "data") {
    // Records arrive in batches before the final event; validate them once.
    const data =
      isJsonObject(event.data) && event.data.records === undefined
        ? { ...event.data, records }
        : event.data;
    return ingestDashboardResponse(data);
  }
  if (event.type === "error" && typeof event.error === "string") {
    if (event.code === "SETUP_REQUIRED") {
      throw new DashboardSetupRequiredError(event.error);
    }
    throw new Error(event.error);
  }
  throw new Error("The local server returned an invalid event.");
}

export async function readDashboardStream(
  body: ReadableStream<Uint8Array> | null,
  onProgress: (progress: DashboardLoadProgress) => void,
): Promise<McpResponse> {
  if (!body) {
    throw new Error("The local server did not provide a progress stream.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const records: unknown[] = [];
  let buffer = "";
  let loadedData: McpResponse | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      loadedData =
        handleDashboardEvent(line, records, onProgress) ?? loadedData;
    }
    if (done) break;
  }
  loadedData = handleDashboardEvent(buffer, records, onProgress) ?? loadedData;
  if (!loadedData) {
    throw new Error("Dashboard data did not finish loading.");
  }
  return loadedData;
}
