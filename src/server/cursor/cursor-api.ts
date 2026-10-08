import type {
  McpRecord,
  McpResponse,
  McpResponseNotice,
} from "../../contracts/mcp-response.js";
import { summarizeMcpRecords } from "../../contracts/mcp-response.js";
import { classifyMcpServer } from "../../contracts/mcp-origin.js";
import {
  activityLimitNotice,
  buildSegments,
  datesBetween,
  DuplicateMetricError,
  formatCount,
  MemoryMcpRun,
  planIncludedDays,
  recordBytes,
  type ActivityLimitReason,
  type CollectionSegment,
  type McpDataset,
  type McpRun,
  type McpRunFactory,
} from "./mcp-collection.js";

const DEFAULT_BASE_URL = "https://api.cursor.com";
const PAGE_SIZE = 500;
const MAX_ATTEMPTS = 5;
const MAX_PAGE_COUNT = 1_000;
const MAX_NO_PROGRESS_PAGES = 3;
const MAX_RETRY_DELAY_MS = 120_000;
const DEFAULT_MAX_RECORDS = 100_000_000;
// Estimated serialized size per record, with headroom for long labels.
const ESTIMATED_RECORD_BYTES = 256;
/**
 * Defaults are sized so that ordinary use never reaches them. Each one is an
 * optional cap that operators can lower; reaching one yields a partial result
 * with a notice instead of an error.
 */
export const DEFAULT_CURSOR_API_LIMITS = {
  maxRecords: DEFAULT_MAX_RECORDS,
  maxResponseBytes: DEFAULT_MAX_RECORDS * ESTIMATED_RECORD_BYTES,
  maxPageBytes: 64 * 1024 * 1024,
  maxDirectoryGroups: 1_000_000,
  maxGroupMemberships: 100_000_000,
  maxEnrichedGroupAssignments: 1_000_000_000,
} as const;
const ADMIN_REQUEST_LIMIT = 20;
const ADMIN_REQUEST_WINDOW_MS = 60_000;
const WINDOW_CONCURRENCY = 4;
const WINDOW_DAYS = 30;
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
  /** Present when a cap stopped directory loading early. */
  notices?: McpResponseNotice[];
}

export interface McpFetchProgress {
  completedWindows: number;
  totalWindows: number;
  cachedDays?: number;
}

export interface McpDatasetOptions {
  memberNames?: Map<string, string>;
  onProgress?: (progress: McpFetchProgress) => void;
  /** Cancels the collection; the returned promise rejects. */
  signal?: AbortSignal;
  /** Stops the collection early; the result is partial with a notice. */
  deadline?: AbortSignal;
  deadlineMs?: number;
  /** Disk-backed storage. Without it, records are collected in memory. */
  runs?: McpRunFactory;
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

/** A single upstream page exceeded the configured page-size cap. */
class PageLimitError extends CursorApiError {
  constructor() {
    super("Cursor API response exceeded the size limit", 502);
    this.name = "PageLimitError";
  }
}

type Fetcher = typeof fetch;
type Sleeper = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type Pagination = { totalPages?: number; hasNextPage?: boolean };
type WindowOutcome = "complete" | "records" | "bytes";

interface WindowHooks {
  /** Remaining capacity for this window, evaluated at the start of a page. */
  allowance(): { records: number; bytes: number };
  consume(records: number, bytes: number): void;
  write(records: McpRecord[]): Promise<void>;
}

export interface CursorApiLimits {
  maxRecords: number;
  maxResponseBytes: number;
  maxPageBytes: number;
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
  createError: () => CursorApiError = () =>
    new CursorApiError("Cursor API response exceeded the size limit", 502),
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw createError();
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
      throw createError();
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

function positiveLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback));
}

function isDeadlineAbort(
  deadline: AbortSignal | undefined,
  signal: AbortSignal | undefined,
): boolean {
  return Boolean(deadline?.aborted) && !signal?.aborted;
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
    maxRecordCount?: number,
    limits: Partial<CursorApiLimits> = {},
  ) {
    this.authorization = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
    this.limits = {
      maxRecords: positiveLimit(
        maxRecordCount ?? limits.maxRecords,
        DEFAULT_CURSOR_API_LIMITS.maxRecords,
      ),
      maxResponseBytes: positiveLimit(
        limits.maxResponseBytes,
        DEFAULT_CURSOR_API_LIMITS.maxResponseBytes,
      ),
      maxPageBytes: positiveLimit(
        limits.maxPageBytes,
        DEFAULT_CURSOR_API_LIMITS.maxPageBytes,
      ),
      maxDirectoryGroups: positiveLimit(
        limits.maxDirectoryGroups,
        DEFAULT_CURSOR_API_LIMITS.maxDirectoryGroups,
      ),
      maxGroupMemberships: positiveLimit(
        limits.maxGroupMemberships,
        DEFAULT_CURSOR_API_LIMITS.maxGroupMemberships,
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
        const text = await readResponseText(
          response,
          this.limits.maxPageBytes,
          () => new PageLimitError(),
        );
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

  /** Validates the key with one small analytics request. */
  async validateApiKey(signal?: AbortSignal): Promise<{ teamId: string }> {
    const today = new Date().toISOString().slice(0, 10);
    const query = new URLSearchParams({
      startDate: today,
      endDate: today,
      page: "1",
      pageSize: "1",
    });
    const payload = requireObject(
      await this.requestJson(`/analytics/by-user/mcp?${query}`, signal),
      "MCP analytics",
    );
    const params =
      payload.params === undefined
        ? undefined
        : requireObject(payload.params, "MCP analytics parameters");
    const teamId = boundedText(params?.teamId, "team ID", 512, true);
    if (teamId && !this.teamId) this.teamId = teamId;
    return { teamId };
  }

  /**
   * Loads members, directory groups, and memberships. Reaching a directory
   * cap or the deadline stops loading and returns what was loaded so far with
   * a notice; `signal` cancels the load entirely.
   */
  async fetchTeamMetadata(
    signal?: AbortSignal,
    onProgress?: (progress: TeamMetadataProgress) => void,
    deadline?: AbortSignal,
    deadlineMs = 0,
  ): Promise<TeamMetadata> {
    const requestSignal =
      deadline && signal
        ? AbortSignal.any([signal, deadline])
        : (deadline ?? signal);
    const rawMemberPayload = await this.requestJson(
      "/teams/members",
      requestSignal,
    );
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

    let stopNotice: McpResponseNotice | undefined;
    const stop = (reason: DirectoryLimitReason, limit: number) => {
      stopNotice ??= directoryLimitNotice(reason, limit);
    };
    const requestDirectoryPage = async (path: string) => {
      try {
        return await this.requestJson(path, requestSignal);
      } catch (error) {
        if (error instanceof PageLimitError) {
          stop("page", this.limits.maxPageBytes);
          return undefined;
        }
        if (isDeadlineAbort(deadline, signal)) {
          stop("timeout", deadlineMs);
          return undefined;
        }
        throw error;
      }
    };

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
    listing: for (let page = 1; ; page += 1) {
      const rawPayload = await requestDirectoryPage(
        `/teams/directory-groups?page=${page}&pageSize=100`,
      );
      if (rawPayload === undefined) break;
      const payload = requireObject(rawPayload, "directory groups");
      const groups = requireObjectArray(payload.groups, "directory groups");
      const pagination = requirePagination(payload.pagination);
      const seenBefore = seenDirectoryGroups.size;
      for (const group of groups) {
        const id = boundedText(group.id, "directory group ID", 512, true);
        const name = boundedText(group.name, "directory group name", 512);
        if (id && name && !seenDirectoryGroups.has(id)) {
          if (directoryGroups.length >= this.limits.maxDirectoryGroups) {
            stop("groups", this.limits.maxDirectoryGroups);
            break listing;
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
        if (stopNotice) return;
        const rawPayload = await requestDirectoryPage(
          `/teams/directory-groups/${encodeURIComponent(group.id)}/members?page=${page}&pageSize=200`,
        );
        if (rawPayload === undefined) return;
        const payload = requireObject(rawPayload, "directory group members");
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
            if (groupMembershipCount >= this.limits.maxGroupMemberships) {
              stop("memberships", this.limits.maxGroupMemberships);
              return;
            }
            groupMembershipCount += 1;
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
      index < directoryGroups.length && !stopNotice;
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
      ...(stopNotice ? { notices: [stopNotice] } : {}),
    };
  }

  /**
   * Fetches one window page by page. Each page is checked against the
   * window's remaining capacity, written out, and released, so memory stays
   * bounded by one page regardless of the window's size.
   */
  private async fetchMcpWindow(
    startDate: string,
    endDate: string,
    memberNames: Map<string, string>,
    hooks: WindowHooks,
    signal?: AbortSignal,
  ): Promise<WindowOutcome> {
    let previousPageKeys = new Set<string>();
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

      const pageKeys = new Set<string>();
      const candidates: { date: string; record?: McpRecord; bytes: number }[] =
        [];
      let madeProgress = false;
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
          if (pageKeys.has(recordKey)) {
            throw new CursorApiError(
              "Cursor API returned a duplicate MCP metric",
              502,
            );
          }
          pageKeys.add(recordKey);
          if (!previousPageKeys.has(recordKey)) madeProgress = true;
          // Zero-usage metrics are not shown but still count as processed.
          if (usage === 0) {
            candidates.push({ date, bytes: 0 });
            continue;
          }
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
          candidates.push({ date, record, bytes: recordBytes(record) });
        }
      }

      // Capacity is read once per page; page processing is synchronous, so
      // no other window can consume it before this page is accounted for.
      const allowance = hooks.allowance();
      const pageBytes = candidates.reduce(
        (total, candidate) => total + candidate.bytes,
        0,
      );
      let outcome: WindowOutcome = "complete";
      let usedRecords = candidates.length;
      let usedBytes = pageBytes;
      const records: McpRecord[] = [];
      if (
        candidates.length <= allowance.records &&
        pageBytes <= allowance.bytes
      ) {
        for (const candidate of candidates) {
          if (candidate.record) records.push(candidate.record);
        }
      } else {
        // Keep the newest days of a page that does not fit.
        candidates.sort((a, b) => b.date.localeCompare(a.date));
        usedRecords = 0;
        usedBytes = 0;
        for (const candidate of candidates) {
          if (usedRecords >= allowance.records) {
            outcome = "records";
            break;
          }
          if (usedBytes + candidate.bytes > allowance.bytes) {
            outcome = "bytes";
            break;
          }
          usedRecords += 1;
          usedBytes += candidate.bytes;
          if (candidate.record) records.push(candidate.record);
        }
      }

      hooks.consume(usedRecords, usedBytes);
      await hooks.write(records);
      if (outcome !== "complete") return outcome;

      const nextCount = nextNoProgressCount(
        pagination,
        page,
        itemCount,
        madeProgress,
        noProgressPages,
      );
      if (nextCount === null) return "complete";
      noProgressPages = nextCount;
      previousPageKeys = pageKeys;
    }
  }

  private activityLimitValue(
    reason: ActivityLimitReason,
    deadlineMs: number,
  ): number {
    switch (reason) {
      case "records":
        return this.limits.maxRecords;
      case "bytes":
        return this.limits.maxResponseBytes;
      case "page":
        return this.limits.maxPageBytes;
      case "timeout":
        return deadlineMs;
    }
  }

  /**
   * Collects fetch windows newest first, four at a time. A window that
   * reaches a cap stops, windows older than it are abandoned, and newer
   * windows run to completion so the newest days stay complete.
   */
  private async collectSegments(
    segments: CollectionSegment[],
    run: McpRun,
    memberNames: Map<string, string>,
    options: McpDatasetOptions,
    cachedDays: number,
  ): Promise<void> {
    const { onProgress, signal, deadline } = options;
    const fetchIndexes = segments.flatMap((segment, index) =>
      segment.kind === "fetch" ? [index] : [],
    );
    const totalWindows = fetchIndexes.length;
    let completedWindows = 0;
    const report = () =>
      onProgress?.({
        completedWindows,
        totalWindows,
        ...(cachedDays > 0 ? { cachedDays } : {}),
      });
    report();
    if (totalWindows === 0) return;

    let boundary = segments.length;
    let failed = false;
    let firstError: unknown;
    const failure = new AbortController();
    const baseSignal = signal
      ? AbortSignal.any([signal, failure.signal])
      : failure.signal;
    const controllers = new Map<number, AbortController>();
    const newerTotals = (index: number) => {
      let records = 0;
      let bytes = 0;
      for (let other = 0; other < index; other += 1) {
        records += segments[other]?.processed ?? 0;
        bytes += segments[other]?.bytes ?? 0;
      }
      return { records, bytes };
    };
    const truncate = (index: number, reason: ActivityLimitReason) => {
      const segment = segments[index];
      if (!segment) return;
      segment.status = "truncated";
      segment.reason = reason;
      if (index < boundary) boundary = index;
      for (const [other, controller] of controllers) {
        if (other > index) {
          controller.abort(
            new DOMException(
              "Window is beyond the result boundary",
              "AbortError",
            ),
          );
        }
      }
    };

    let nextQueueIndex = 0;
    const worker = async () => {
      for (;;) {
        if (failed || baseSignal.aborted || deadline?.aborted) return;
        const index = fetchIndexes[nextQueueIndex];
        nextQueueIndex += 1;
        if (index === undefined) return;
        const segment = segments[index];
        if (!segment) return;
        if (index > boundary) {
          segment.status = "abandoned";
          completedWindows += 1;
          report();
          continue;
        }
        const controller = new AbortController();
        controllers.set(index, controller);
        const windowSignal = AbortSignal.any([
          baseSignal,
          controller.signal,
          ...(deadline ? [deadline] : []),
        ]);
        segment.status = "running";
        try {
          const outcome = await this.fetchMcpWindow(
            segment.startDate,
            segment.endDate,
            memberNames,
            {
              allowance: () => {
                if (index > boundary) return { records: 0, bytes: 0 };
                const newer = newerTotals(index);
                return {
                  records: Math.max(
                    0,
                    this.limits.maxRecords - newer.records - segment.processed,
                  ),
                  bytes: Math.max(
                    0,
                    this.limits.maxResponseBytes - newer.bytes - segment.bytes,
                  ),
                };
              },
              consume: (records, bytes) => {
                segment.processed += records;
                segment.bytes += bytes;
              },
              write: (records) => run.write(records),
            },
            windowSignal,
          );
          if (outcome === "complete") {
            segment.days = await run.sealWindow(segment.dates, true);
            segment.status = "complete";
          } else if (index > boundary) {
            segment.status = "abandoned";
          } else {
            truncate(index, outcome);
            segment.days = await run.sealWindow(segment.dates, false);
          }
        } catch (error) {
          if (signal?.aborted || failed) return;
          if (isDeadlineAbort(deadline, signal)) {
            truncate(index, "timeout");
            segment.days = await run.sealWindow(segment.dates, false);
          } else if (controller.signal.aborted) {
            segment.status = "abandoned";
          } else if (error instanceof PageLimitError) {
            truncate(index, "page");
            segment.days = await run.sealWindow(segment.dates, false);
          } else {
            failed = true;
            firstError = error;
            failure.abort(error);
            return;
          }
        } finally {
          controllers.delete(index);
        }
        completedWindows += 1;
        report();
      }
    };

    const results = await Promise.allSettled(
      Array.from({ length: Math.min(WINDOW_CONCURRENCY, totalWindows) }, () =>
        worker(),
      ),
    );
    if (failed) throw firstError;
    signal?.throwIfAborted();
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    const fallbackReason: ActivityLimitReason = deadline?.aborted
      ? "timeout"
      : (segments[boundary]?.reason ?? "records");
    for (const segment of segments) {
      if (segment.status === "pending" || segment.status === "running") {
        segment.status = "truncated";
        segment.reason = fallbackReason;
      }
    }
  }

  /**
   * Collects MCP activity for a range into a dataset that can be read one
   * day at a time. With a run factory, valid cached days are reused and only
   * the remaining days are fetched. Reaching a cap or the deadline yields a
   * partial dataset with a notice rather than an error.
   */
  async fetchMcpDataset(
    startDate: string,
    endDate: string,
    options: McpDatasetOptions = {},
  ): Promise<McpDataset> {
    const run = options.runs
      ? await options.runs.beginRun()
      : new MemoryMcpRun();
    try {
      const dates = datesBetween(startDate, endDate);
      const cached = await run.adoptCachedDays(dates);
      const segments = buildSegments(dates, cached, WINDOW_DAYS);
      await this.collectSegments(
        segments,
        run,
        options.memberNames ?? new Map(),
        options,
        cached.size,
      );
      const plan = planIncludedDays(segments, {
        maxRecords: this.limits.maxRecords,
        maxBytes: this.limits.maxResponseBytes,
      });
      const days = [];
      for (const day of plan.days) {
        if (day.maxBytes === undefined) {
          days.push(
            day.limit === undefined
              ? { date: day.date }
              : { date: day.date, limit: day.limit },
          );
          continue;
        }
        const limit = await run.countWithinBytes(
          day.date,
          day.limit ?? Number.MAX_SAFE_INTEGER,
          day.maxBytes,
        );
        if (limit > 0) days.push({ date: day.date, limit });
      }
      const range = { startDate, endDate };
      const notices = plan.limit
        ? [
            activityLimitNotice(
              plan.limit.reason,
              this.activityLimitValue(
                plan.limit.reason,
                options.deadlineMs ?? 0,
              ),
              range,
              plan.limit.completeFrom,
            ),
          ]
        : [];
      const teamId = this.teamId;
      return run.createDataset(days, {
        range,
        generatedAt: new Date().toISOString(),
        ...(teamId || this.teamName
          ? {
              team: {
                id: teamId,
                name: this.teamName || (teamId ? `Team ${teamId}` : "Team"),
              },
            }
          : {}),
        notices,
      });
    } catch (error) {
      await run.discard().catch(() => undefined);
      if (error instanceof DuplicateMetricError) {
        throw new CursorApiError(error.message, 502);
      }
      throw error;
    }
  }

  async fetchMcp(
    startDate: string,
    endDate: string,
    memberNames = new Map<string, string>(),
    onProgress?: (progress: McpFetchProgress) => void,
    signal?: AbortSignal,
    deadline?: { signal: AbortSignal; milliseconds: number },
  ): Promise<McpResponse> {
    const dataset = await this.fetchMcpDataset(startDate, endDate, {
      memberNames,
      onProgress,
      signal,
      deadline: deadline?.signal,
      deadlineMs: deadline?.milliseconds,
    });
    const records: McpRecord[] = [];
    for await (const day of dataset.readDays("ascending")) {
      for (const record of day.records) records.push(record);
    }
    return {
      records,
      summary: summarizeMcpRecords(records),
      range: dataset.range,
      generatedAt: dataset.generatedAt,
      source: "live",
      team: dataset.team
        ? { ...dataset.team, memberCount: 0, groupCount: 0 }
        : undefined,
      ...(dataset.notices.length > 0 ? { notices: dataset.notices } : {}),
    };
  }
}

type DirectoryLimitReason = "groups" | "memberships" | "page" | "timeout";

function directoryLimitNotice(
  reason: DirectoryLimitReason,
  limit: number,
): McpResponseNotice {
  const details: Record<
    DirectoryLimitReason,
    { setting: string; cause: string; scope: string }
  > = {
    groups: {
      setting: "MAX_DIRECTORY_GROUPS",
      cause: `the ${formatCount(limit)}-group limit`,
      scope: "every group",
    },
    memberships: {
      setting: "MAX_GROUP_MEMBERSHIPS",
      cause: `the ${formatCount(limit)}-membership limit`,
      scope: "every membership",
    },
    page: {
      setting: "MAX_API_PAGE_BYTES",
      cause: `the ${formatCount(limit)}-byte page limit`,
      scope: "every group",
    },
    timeout: {
      setting: "DIRECTORY_LOAD_TIMEOUT_MS",
      cause: `the ${formatCount(limit)} ms directory time limit`,
      scope: "every group",
    },
  };
  const { setting, cause, scope } = details[reason];
  return {
    code: "LIMIT_REACHED",
    message: `Directory groups are partial: ${cause} (${setting}) was reached. Raise ${setting} to load ${scope}. Activity totals are not affected.`,
    setting,
    limit,
  };
}
