import type { McpResponse } from "../../contracts/mcp-response";
import { ingestDashboardResponse } from "./dashboard-response";
import { isJsonObject } from "./dashboard-api-client";

export interface DashboardLoadProgress {
  completed: number;
  total: number;
  label: string;
  detail: string;
}

export class DashboardSetupRequiredError extends Error {
  readonly code = "SETUP_REQUIRED";
}

function handleDashboardEvent(
  line: string,
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
    onProgress({
      completed: event.completed,
      total: event.total,
      label: event.label,
      detail: event.detail,
    });
    return null;
  }
  if (event.type === "data") {
    return ingestDashboardResponse(event.data);
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
  let buffer = "";
  let loadedData: McpResponse | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      loadedData = handleDashboardEvent(line, onProgress) ?? loadedData;
    }
    if (done) break;
  }
  loadedData = handleDashboardEvent(buffer, onProgress) ?? loadedData;
  if (!loadedData) {
    throw new Error("Dashboard data did not finish loading.");
  }
  return loadedData;
}
