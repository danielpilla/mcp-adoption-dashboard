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

export interface DashboardLoadProgress {
  completed: number;
  total: number;
  label: string;
  detail: string;
  directory?: DirectoryLoadProgress;
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
    onProgress({
      completed: event.completed,
      total: event.total,
      label: event.label,
      detail: event.detail,
      ...(directory ? { directory } : {}),
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
