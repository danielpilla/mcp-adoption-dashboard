import type { McpRecord, McpResponse } from "../../contracts/mcp-response.js";
import { summarizeMcpRecords } from "../../contracts/mcp-response.js";
import { classifyMcpServer } from "../../contracts/mcp-origin.js";

const DEFAULT_BASE_URL = "https://api.cursor.com";
const PAGE_SIZE = 500;
const MAX_ATTEMPTS = 5;
const MAX_PAGE_COUNT = 1_000;
const MAX_NO_PROGRESS_PAGES = 3;
const MAX_RETRY_DELAY_MS = 120_000;
const DEFAULT_MAX_RECORD_COUNT = 250_000;
export const DEFAULT_CURSOR_API_LIMITS = {
  maxResponseBytes: 128 * 1024 * 1024,
  maxDirectoryGroups: 10_000,
  maxGroupMemberships: 250_000,
  maxEnrichedGroupAssignments: 250_000,
} as const;
const ADMIN_REQUEST_LIMIT = 20;
const ADMIN_REQUEST_WINDOW_MS = 60_000;
const WINDOW_CONCURRENCY = 4;
const MAX_JSON_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface TeamUserMetadata {
  name: string;
  role: string;
  directoryGroups: string[];
}

export interface TeamMetadata {
  users: Map<string, TeamUserMetadata>;
  memberCount: number;
  groupNames: string[];
}

export interface McpFetchProgress {
  completedWindows: number;
  totalWindows: number;
}

export interface TeamMetadataProgress {
  completedGroups: number;
  totalGroups?: number;
}

export class CursorApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "CursorApiError";
  }
}

type Fetcher = typeof fetch;
type Sleeper = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type Pagination = { totalPages?: number; hasNextPage?: boolean };
type RecordBudget = { remaining: number; remainingBytes: number };

export interface CursorApiLimits {
  maxResponseBytes: number;
  maxDirectoryGroups: number;
  maxGroupMemberships: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new CursorApiError(`Cursor API returned invalid ${description}`, 502);
  }
  return value;
}

function requireOptionalArray(value: unknown, description: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CursorApiError(`Cursor API returned invalid ${description}`, 502);
  }
  return value;
}

function requireObjectArray(
  value: unknown,
  description: string,
): Array<Record<string, unknown>> {
  return requireOptionalArray(value, description).map((item) =>
    requireObject(item, `${description} item`),
  );
}

function requirePagination(value: unknown): Pagination {
  const pagination = requireObject(value, "pagination");
  if (
    pagination.totalPages !== undefined &&
    (!Number.isSafeInteger(pagination.totalPages) ||
      Number(pagination.totalPages) < 0)
  ) {
    throw new CursorApiError("Cursor API returned invalid pagination", 502);
  }
  if (
    pagination.hasNextPage !== undefined &&
    typeof pagination.hasNextPage !== "boolean"
  ) {
    throw new CursorApiError("Cursor API returned invalid pagination", 502);
  }
  if (
    pagination.totalPages === undefined &&
    pagination.hasNextPage === undefined
  ) {
    throw new CursorApiError("Cursor API returned incomplete pagination", 502);
  }
  return {
    ...(pagination.totalPages !== undefined
      ? { totalPages: Number(pagination.totalPages) }
      : {}),
    ...(typeof pagination.hasNextPage === "boolean"
      ? { hasNextPage: pagination.hasNextPage }
      : {}),
  };
}

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return ["", "null", "none", "undefined"].includes(text.toLowerCase())
    ? ""
    : text;
}

function boundedText(
  value: unknown,
  description: string,
  maxLength: number,
  allowNumber = false,
): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value !== "string" &&
    !(allowNumber && typeof value === "number")
  ) {
    throw new CursorApiError(`Cursor API returned invalid ${description}`, 502);
  }
  const text = clean(value);
  if (text.includes("\0") || text.length > maxLength) {
    throw new CursorApiError(
      `Cursor API returned oversized ${description}`,
      502,
    );
  }
  return text;
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function shouldFetchNextPage(
  pagination: Pagination | undefined,
  page: number,
  itemCount: number,
): boolean {
  if (typeof pagination?.hasNextPage === "boolean") {
    return pagination.hasNextPage;
  }
  const totalPages = Number(pagination?.totalPages ?? 1);
  return (
    itemCount > 0 &&
    page < (Number.isFinite(totalPages) ? Math.max(1, totalPages) : 1)
  );
}

function nextNoProgressCount(
  pagination: Pagination | undefined,
  page: number,
  itemCount: number,
  madeProgress: boolean,
  noProgressPages: number,
): number | null {
  if (!shouldFetchNextPage(pagination, page, itemCount)) return null;
  if (page >= MAX_PAGE_COUNT) {
    throw new CursorApiError("Cursor API pagination limit exceeded", 502);
  }
  const nextCount = madeProgress ? 0 : noProgressPages + 1;
  if (nextCount >= MAX_NO_PROGRESS_PAGES) {
    throw new CursorApiError("Cursor API pagination made no progress", 502);
  }
  return nextCount;
}

function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  let onAbort: (() => void) | undefined;
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timeout = setTimeout(resolve, milliseconds);
    onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout.unref();
  }).finally(() => {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new CursorApiError(
      "Cursor API response exceeded the size limit",
      502,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CursorApiError(
        "Cursor API response exceeded the size limit",
        502,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function retryDelayMilliseconds(
  retryAfter: string | null,
  fallback: number,
  now = Date.now(),
): number {
  const capped = (delay: number) =>
    Math.min(MAX_RETRY_DELAY_MS, Math.max(0, delay));
  if (retryAfter === null || retryAfter.trim() === "") {
    return capped(fallback);
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return capped(seconds * 1_000);
  }
  const retryAt = Date.parse(retryAfter);
  return capped(Number.isFinite(retryAt) ? retryAt - now : fallback);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      signal?.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) {
        throw new RangeError(`Missing concurrency item at index ${index}.`);
      }
      results[index] = await mapper(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

export class CursorApiClient {
  private readonly authorization: string;
  private readonly limits: CursorApiLimits;
  private teamId = "";
  private adminRequestTimes: number[] = [];
  private adminRequestQueue = Promise.resolve();

  constructor(
    apiKey: string,
    private readonly baseUrl = DEFAULT_BASE_URL,
    private readonly fetcher: Fetcher = fetch,
    private readonly sleep: Sleeper = abortableSleep,
    private readonly teamName = "",
    private readonly maxRecordCount = DEFAULT_MAX_RECORD_COUNT,
    limits: Partial<CursorApiLimits> = {},
  ) {
    this.authorization = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
    this.limits = {
      maxResponseBytes: Math.max(
        1,
        Math.floor(
          limits.maxResponseBytes ?? DEFAULT_CURSOR_API_LIMITS.maxResponseBytes,
        ),
      ),
      maxDirectoryGroups: Math.max(
        1,
        Math.floor(
          limits.maxDirectoryGroups ??
            DEFAULT_CURSOR_API_LIMITS.maxDirectoryGroups,
        ),
      ),
      maxGroupMemberships: Math.max(
        1,
        Math.floor(
          limits.maxGroupMemberships ??
            DEFAULT_CURSOR_API_LIMITS.maxGroupMemberships,
        ),
      ),
    };
  }

  private async wait(
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!signal) {
      await this.sleep(milliseconds);
      return;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(milliseconds, signal), aborted]);
      signal.throwIfAborted();
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async reserveAdminRequest(signal?: AbortSignal): Promise<void> {
    const reserve = this.adminRequestQueue.then(async () => {
      signal?.throwIfAborted();
      const now = Date.now();
      this.adminRequestTimes = this.adminRequestTimes.filter(
        (timestamp) => now - timestamp < ADMIN_REQUEST_WINDOW_MS,
      );
      if (this.adminRequestTimes.length >= ADMIN_REQUEST_LIMIT) {
        const oldestRequestTime = this.adminRequestTimes[0];
        if (oldestRequestTime === undefined) {
          throw new RangeError("Admin request history is unexpectedly empty.");
        }
        const waitFor = ADMIN_REQUEST_WINDOW_MS - (now - oldestRequestTime);
        await this.wait(waitFor, signal);
        const resumedAt = Date.now();
        this.adminRequestTimes = this.adminRequestTimes.filter(
          (timestamp) => resumedAt - timestamp < ADMIN_REQUEST_WINDOW_MS,
        );
      }
      this.adminRequestTimes.push(Date.now());
    });
    this.adminRequestQueue = reserve.catch(() => undefined);
    await reserve;
  }

  private async requestJson(
    path: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      let response: Response;
      try {
        if (path.startsWith("/teams/") || path.startsWith("/organizations/")) {
          await this.reserveAdminRequest(signal);
        }
        const timeoutSignal = AbortSignal.timeout(120_000);
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          headers: {
            Accept: "application/json",
            Authorization: this.authorization,
          },
          signal: signal
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt < MAX_ATTEMPTS - 1) {
          await this.wait(2 ** attempt * 250, signal);
          signal?.throwIfAborted();
          continue;
        }
        throw new CursorApiError(
          `Cursor API request failed: ${error instanceof Error ? error.message : "network error"}`,
          502,
        );
      }

      if (response.ok) {
        const text = await readResponseText(response, MAX_JSON_RESPONSE_BYTES);
        try {
          const parsed: unknown = JSON.parse(text);
          return parsed;
        } catch {
          throw new CursorApiError("Cursor API returned malformed JSON", 502);
        }
      }

      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < MAX_ATTEMPTS - 1
      ) {
        if (response.body) {
          await response.body.cancel().catch(() => undefined);
        }
        await this.wait(
          retryDelayMilliseconds(
            response.headers.get("retry-after"),
            2 ** attempt * 500,
          ),
          signal,
        );
        signal?.throwIfAborted();
        continue;
      }

      const detail = clean(
        await readResponseText(response, MAX_ERROR_RESPONSE_BYTES),
      ).slice(0, 500);
      throw new CursorApiError(
        detail
          ? `Cursor API returned ${response.status}: ${detail}`
          : `Cursor API returned ${response.status}`,
        response.status,
      );
    }

    throw new CursorApiError("Cursor API retry limit exceeded", 502);
  }

  async fetchTeamMetadata(
    signal?: AbortSignal,
    onProgress?: (progress: TeamMetadataProgress) => void,
  ): Promise<TeamMetadata> {
    const rawMemberPayload = await this.requestJson("/teams/members", signal);
    const memberPayload = requireObject(rawMemberPayload, "team members");
    const teamMembers = requireObjectArray(
      memberPayload.teamMembers,
      "team members",
    );

    const users = new Map<string, TeamUserMetadata>();
    const emailById = new Map<string, string>();
    for (const member of teamMembers) {
      if (member.isRemoved === true) continue;
      const email = boundedText(
        member.email,
        "team member email",
        320,
      ).toLowerCase();
      if (!email) continue;
      const id = boundedText(member.id, "team member ID", 512, true);
      if (id) emailById.set(id, email);
      users.set(email, {
        name:
          boundedText(member.name, "team member name", 512) ||
          email.split("@")[0] ||
          email,
        role: boundedText(member.role, "team member role", 128),
        directoryGroups: [],
      });
    }
    onProgress?.({ completedGroups: 0 });

    const resolveEmail = (member: {
      userId?: unknown;
      id?: unknown;
      email?: unknown;
    }) =>
      boundedText(member.email, "group member email", 320).toLowerCase() ||
      emailById.get(
        boundedText(member.userId ?? member.id, "group member ID", 512, true),
      ) ||
      "";
    const groupNames = new Set<string>();
    const directoryGroups: Array<{ id: string; name: string }> = [];
    const seenDirectoryGroups = new Set<string>();
    let directoryGroupNoProgressPages = 0;
    for (let page = 1; ; page += 1) {
      const payload = requireObject(
        await this.requestJson(
          `/teams/directory-groups?page=${page}&pageSize=100`,
          signal,
        ),
        "directory groups",
      );
      const groups = requireObjectArray(payload.groups, "directory groups");
      const pagination = requirePagination(payload.pagination);
      const seenBefore = seenDirectoryGroups.size;
      for (const group of groups) {
        const id = boundedText(group.id, "directory group ID", 512, true);
        const name = boundedText(group.name, "directory group name", 512);
        if (id && name && !seenDirectoryGroups.has(id)) {
          if (directoryGroups.length >= this.limits.maxDirectoryGroups) {
            throw new CursorApiError(
              "Cursor API directory groups exceed the configured safety limit",
              502,
            );
          }
          seenDirectoryGroups.add(id);
          directoryGroups.push({ id, name });
          groupNames.add(name);
        }
      }
      const nextCount = nextNoProgressCount(
        pagination,
        page,
        groups.length,
        seenDirectoryGroups.size > seenBefore,
        directoryGroupNoProgressPages,
      );
      if (nextCount === null) break;
      directoryGroupNoProgressPages = nextCount;
    }
    onProgress?.({
      completedGroups: 0,
      totalGroups: directoryGroups.length,
    });

    let groupMembershipCount = 0;
    const loadDirectoryGroup = async (group: { id: string; name: string }) => {
      const seenMembers = new Set<string>();
      let noProgressPages = 0;
      for (let page = 1; ; page += 1) {
        const payload = requireObject(
          await this.requestJson(
            `/teams/directory-groups/${encodeURIComponent(group.id)}/members?page=${page}&pageSize=200`,
            signal,
          ),
          "directory group members",
        );
        const members = requireObjectArray(
          payload.members,
          "directory group members",
        );
        const pagination = requirePagination(payload.pagination);
        const seenBefore = seenMembers.size;
        for (const member of members) {
          const email = resolveEmail(member);
          const identity =
            email ||
            boundedText(
              member.userId ?? member.id,
              "directory group member ID",
              512,
              true,
            );
          if (identity && !seenMembers.has(identity)) {
            groupMembershipCount += 1;
            if (groupMembershipCount > this.limits.maxGroupMemberships) {
              throw new CursorApiError(
                "Cursor API group memberships exceed the configured safety limit",
                502,
              );
            }
            seenMembers.add(identity);
          }
          const metadata = users.get(email);
          if (metadata && !metadata.directoryGroups.includes(group.name)) {
            metadata.directoryGroups.push(group.name);
          }
        }
        const nextCount = nextNoProgressCount(
          pagination,
          page,
          members.length,
          seenMembers.size > seenBefore,
          noProgressPages,
        );
        if (nextCount === null) break;
        noProgressPages = nextCount;
      }
    };

    let completedGroups = 0;
    for (
      let index = 0;
      index < directoryGroups.length;
      index += WINDOW_CONCURRENCY
    ) {
      const batch = directoryGroups.slice(index, index + WINDOW_CONCURRENCY);
      await Promise.all(
        batch.map(async (group) => {
          await loadDirectoryGroup(group);
          completedGroups += 1;
          onProgress?.({
            completedGroups,
            totalGroups: directoryGroups.length,
          });
        }),
      );
    }

    return {
      users,
      memberCount: users.size,
      groupNames: [...groupNames].sort((a, b) => a.localeCompare(b)),
    };
  }

  private async fetchMcpWindow(
    startDate: string,
    endDate: string,
    memberNames: Map<string, string>,
    budget: RecordBudget,
    signal?: AbortSignal,
  ): Promise<McpRecord[]> {
    const records: McpRecord[] = [];
    const metricKeys = new Set<string>();
    let noProgressPages = 0;

    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        startDate,
        endDate,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const payload = requireObject(
        await this.requestJson(`/analytics/by-user/mcp?${query}`, signal),
        "MCP analytics",
      );
      const data = requireObject(payload.data, "MCP analytics data");
      const pagination = requirePagination(payload.pagination);
      const params =
        payload.params === undefined
          ? undefined
          : requireObject(payload.params, "MCP analytics parameters");
      const userMappings = requireObjectArray(
        params?.userMappings,
        "MCP user mappings",
      );
      const metricCountBefore = metricKeys.size;
      const responseTeamId = boundedText(params?.teamId, "team ID", 512, true);
      if (responseTeamId) {
        if (this.teamId && this.teamId !== responseTeamId) {
          throw new CursorApiError(
            "Cursor API returned inconsistent team identifiers",
            502,
          );
        }
        this.teamId = responseTeamId;
      }
      const idByEmail = new Map(
        userMappings.map((mapping) => [
          boundedText(mapping.email, "user mapping email", 320).toLowerCase(),
          boundedText(mapping.id, "user mapping ID", 512, true),
        ]),
      );

      let itemCount = 0;
      for (const [rawEmail, rawMetrics] of Object.entries(data)) {
        const email = boundedText(
          rawEmail,
          "analytics email",
          320,
        ).toLowerCase();
        if (!email || !Array.isArray(rawMetrics)) {
          throw new CursorApiError(
            "Cursor API returned invalid MCP analytics data",
            502,
          );
        }
        itemCount += rawMetrics.length;

        for (const rawMetric of rawMetrics) {
          const metric = requireObject(rawMetric, "MCP metric");
          const usage = metric.usage;
          const date = boundedText(metric.event_date, "metric date", 10);
          const server =
            boundedText(metric.mcp_server_name, "MCP server name", 512) ||
            "Unnamed MCP";
          const tool =
            boundedText(metric.tool_name, "MCP tool name", 512) ||
            "Unnamed tool";
          if (
            !isValidIsoDate(date) ||
            date < startDate ||
            date > endDate ||
            typeof usage !== "number" ||
            !Number.isSafeInteger(usage) ||
            usage < 0
          ) {
            throw new CursorApiError(
              "Cursor API returned an invalid MCP metric",
              502,
            );
          }
          const recordKey = JSON.stringify([email, date, server, tool]);
          if (metricKeys.has(recordKey)) {
            throw new CursorApiError(
              "Cursor API returned a duplicate MCP metric",
              502,
            );
          }
          metricKeys.add(recordKey);
          // Window workers share this budget, but reserve it synchronously
          // between awaits so another worker cannot pass the same capacity.
          if (budget.remaining <= 0) {
            throw new CursorApiError(
              `Cursor API result exceeds the ${this.maxRecordCount.toLocaleString()}-record safety limit`,
              502,
            );
          }
          budget.remaining -= 1;
          if (usage === 0) continue;

          const record: McpRecord = {
            date,
            userId: idByEmail.get(email) || email,
            email,
            displayName: memberNames.get(email) || email.split("@")[0] || email,
            server,
            tool,
            usage,
            origin: classifyMcpServer(server),
          };
          const recordBytes =
            Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
          if (recordBytes > budget.remainingBytes) {
            throw new CursorApiError(
              "Cursor API analytics exceed the configured response-size safety limit",
              502,
            );
          }
          budget.remainingBytes -= recordBytes;
          records.push(record);
        }
      }

      const nextCount = nextNoProgressCount(
        pagination,
        page,
        itemCount,
        metricKeys.size > metricCountBefore,
        noProgressPages,
      );
      if (nextCount === null) break;
      noProgressPages = nextCount;
    }

    return records;
  }

  async fetchMcp(
    startDate: string,
    endDate: string,
    memberNames = new Map<string, string>(),
    onProgress?: (progress: McpFetchProgress) => void,
    signal?: AbortSignal,
  ): Promise<McpResponse> {
    const windows: Array<{ startDate: string; endDate: string }> = [];
    const finalDate = new Date(`${endDate}T00:00:00.000Z`);
    let windowStart = new Date(`${startDate}T00:00:00.000Z`);

    while (windowStart <= finalDate) {
      const windowEnd = new Date(windowStart);
      windowEnd.setUTCDate(windowEnd.getUTCDate() + 29);
      if (windowEnd > finalDate) windowEnd.setTime(finalDate.getTime());
      const chunkStartDate = windowStart.toISOString().slice(0, 10);
      const chunkEndDate = windowEnd.toISOString().slice(0, 10);
      windows.push({ startDate: chunkStartDate, endDate: chunkEndDate });

      windowStart = new Date(windowEnd);
      windowStart.setUTCDate(windowStart.getUTCDate() + 1);
    }

    let completedWindows = 0;
    const budget: RecordBudget = {
      remaining: Math.max(1, Math.floor(this.maxRecordCount)),
      remainingBytes: this.limits.maxResponseBytes,
    };
    onProgress?.({ completedWindows, totalWindows: windows.length });
    const siblingController = new AbortController();
    const windowSignal = signal
      ? AbortSignal.any([signal, siblingController.signal])
      : siblingController.signal;
    let firstError: unknown;
    let hasFirstError = false;
    let windowRecords: McpRecord[][];
    try {
      windowRecords = await mapWithConcurrency(
        windows,
        WINDOW_CONCURRENCY,
        async (window) => {
          try {
            const records = await this.fetchMcpWindow(
              window.startDate,
              window.endDate,
              memberNames,
              budget,
              windowSignal,
            );
            completedWindows += 1;
            onProgress?.({
              completedWindows,
              totalWindows: windows.length,
            });
            return records;
          } catch (error) {
            if (!hasFirstError) {
              hasFirstError = true;
              firstError = error;
              siblingController.abort(error);
            }
            throw firstError;
          }
        },
        windowSignal,
      );
    } catch (error) {
      throw hasFirstError ? firstError : error;
    }
    const records = windowRecords.flat();
    if (records.length > this.maxRecordCount) {
      throw new CursorApiError(
        `Cursor API result exceeds the ${this.maxRecordCount.toLocaleString()}-record safety limit`,
        502,
      );
    }
    const teamId = this.teamId;

    records.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.server.localeCompare(b.server) ||
        a.email.localeCompare(b.email) ||
        a.tool.localeCompare(b.tool),
    );

    return {
      records,
      summary: summarizeMcpRecords(records),
      range: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      source: "live",
      team:
        teamId || this.teamName
          ? {
              id: teamId,
              name: this.teamName || (teamId ? `Team ${teamId}` : "Team"),
              memberCount: 0,
              groupCount: 0,
            }
          : undefined,
    };
  }
}

export function enrichMcpResponse(
  response: McpResponse,
  metadata: TeamMetadata,
  teamName = "",
  maxGroupAssignments: number = DEFAULT_CURSOR_API_LIMITS.maxEnrichedGroupAssignments,
): McpResponse {
  const assignmentLimit = Math.max(1, Math.floor(maxGroupAssignments));
  let groupAssignments = 0;
  const records = response.records.map((record) => {
    const user = metadata.users.get(record.email);
    if (!user) return record;
    groupAssignments += user.directoryGroups.length;
    if (groupAssignments > assignmentLimit) {
      throw new CursorApiError(
        "Enriched group assignments exceed the configured safety limit",
        502,
      );
    }
    return {
      ...record,
      displayName: user.name,
      role: user.role,
      directoryGroups: [...user.directoryGroups],
    };
  });
  const teamId = response.team?.id ?? "";
  return {
    ...response,
    records,
    team: {
      id: teamId,
      name:
        teamName || response.team?.name || (teamId ? `Team ${teamId}` : "Team"),
      memberCount: metadata.memberCount,
      groupCount: metadata.groupNames.length,
    },
  };
}
