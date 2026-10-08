import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import path from "node:path";
import type {
  McpResponse,
  McpResponseNotice,
} from "../../contracts/mcp-response.js";
import {
  CursorApiClient,
  CursorApiError,
  type McpFetchProgress,
  type TeamMetadata,
} from "../cursor/cursor-api.js";
import {
  createMemoryDataset,
  formatCount,
  type McpDataset,
  type McpRunFactory,
} from "../cursor/mcp-collection.js";
import { isLoopbackHost } from "../configuration/server-configuration.js";
import { DEFAULT_RUNTIME_SETTINGS } from "../configuration/runtime-settings.js";
import { validateDateRange } from "../analytics/analytics-date-range.js";
import {
  daysBetween,
  parseStartupRange,
  type CacheCoverage,
} from "../../contracts/startup-range.js";
import type { StartupRangeStorage } from "../configuration/startup-range-store.js";
import {
  TeamMetadataCache,
  type DirectorySnapshot,
} from "../cursor/team-metadata-cache.js";
import {
  writeJsonResponse,
  writeNdjsonResponse,
  type ChunkWriter,
  type ResponseContext,
} from "./mcp-response-writer.js";

/** Disk-backed activity storage bound to the active API key. */
interface ActivityStore extends McpRunFactory {
  activate(apiKey: string): Promise<void>;
  /** Cached-day coverage, computed without reading day files. */
  coverage?(): CacheCoverage;
}

interface AppOptions {
  client?: CursorApiClient;
  initialTeamMetadata?: TeamMetadata;
  initialClientValidation?: Promise<{
    status: "valid" | "invalid" | "deferred";
    metadata?: TeamMetadata;
  }>;
  setup?: {
    allowed: boolean;
    configure: (
      apiKey: string,
      signal?: AbortSignal,
    ) => Promise<
      CursorApiClient | { client: CursorApiClient; metadata: TeamMetadata }
    >;
    persist?: (apiKey: string) => Promise<void>;
  };
  staticDir?: string;
  loadTeamMetadata?: boolean;
  teamName?: string;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  cacheMaxRecords?: number;
  maxEnrichedGroupAssignments?: number;
  maxConcurrentAnalytics?: number;
  analyticsTimeoutMs?: number;
  directoryTimeoutMs?: number;
  /** How long a finished analytics request waits for a loading directory. */
  directoryGraceMs?: number;
  activityStore?: ActivityStore;
  loopbackOnly?: boolean;
  shutdownSignal?: AbortSignal;
  /** Inclusive length of the range pre-selected at startup when none is remembered. */
  defaultRangeDays?: number;
  /** Remembers the range chosen at startup. */
  startupRanges?: StartupRangeStorage;
}

interface AnalyticsCacheEntry {
  startedAt: number;
  expiresAt: number;
  value: Promise<McpDataset>;
  controller?: AbortController;
  progress: McpFetchProgress;
  progressEvents: McpFetchProgress[];
  progressListeners: Set<() => void>;
  recordCount: number;
  settled: boolean;
  subscribers: number;
  /** Readers plus the cache itself; storage is released when this reaches 0. */
  holders: number;
  releaseCacheHold?: () => void;
}

interface ClientSnapshot {
  client: CursorApiClient;
  generation: number;
}

class AnalyticsCapacityError extends Error {
  constructor() {
    super("Too many analytics requests are already in progress.");
    this.name = "AnalyticsCapacityError";
  }
}

const DEFAULT_CACHE_MAX_ENTRIES = 100;
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60_000;
const DEFAULT_MAX_CONCURRENT_ANALYTICS = 4;
const DEFAULT_DIRECTORY_GRACE_MS = 2_000;
const REFRESH_COOLDOWN_MS = 10_000;
const JSON_BODY_LIMIT = "4kb";

/** The `activity` object of a stream progress event. */
interface ActivityProgressEvent {
  state: "loading" | "reused" | "ready";
  totalDays: number;
  cachedDays: number;
  fetchedDays: number;
  records: number;
  completedWindows: number;
  totalWindows: number;
  windows: NonNullable<McpFetchProgress["activeWindows"]>;
  retry: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    waitedMs: number;
    reason: string;
    status: number | null;
  } | null;
  elapsedMs: number;
  idleMs: number;
}
const CONFIGURATION_SUPERSEDED_RESPONSE = {
  error: "A newer API key update was submitted. Retry if needed.",
  code: "CONFIGURATION_SUPERSEDED",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isClientSnapshot(value: unknown): value is ClientSnapshot {
  return (
    isObject(value) &&
    value.client instanceof CursorApiClient &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation)
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function hasLoopbackAuthority(authority: string | undefined): boolean {
  if (!authority || /[,\s/@\\]/.test(authority)) return false;
  try {
    return isLoopbackHost(new URL(`http://${authority}`).hostname);
  } catch {
    return false;
  }
}

function hasLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHost(url.hostname)
    );
  } catch {
    return false;
  }
}

function datasetFromResponse(response: McpResponse): McpDataset {
  const days = new Map<string, McpResponse["records"]>();
  for (const record of response.records) {
    const day = days.get(record.date);
    if (day) day.push(record);
    else days.set(record.date, [record]);
  }
  return createMemoryDataset(
    [...days].map(([date, records]) => ({ date, records })),
    {
      range: response.range,
      generatedAt: response.generatedAt,
      ...(response.team
        ? { team: { id: response.team.id, name: response.team.name } }
        : {}),
      notices: response.notices ?? [],
    },
  );
}

function directoryNotices(directory: DirectorySnapshot): McpResponseNotice[] {
  if (directory.metadata) return [];
  if (directory.status === "loading") {
    const progress = directory.progress;
    const detail =
      progress?.totalGroups === undefined
        ? "team members are loading"
        : `${formatCount(progress.completedGroups)} of ${formatCount(progress.totalGroups)} groups loaded`;
    return [
      {
        code: "DIRECTORY_LOADING",
        message: `Directory groups are still loading (${detail}). Activity is complete; names, roles, and group filters update when the directory finishes loading.`,
      },
    ];
  }
  if (directory.status === "failed") {
    return [
      {
        code: "DIRECTORY_UNAVAILABLE",
        message:
          "Directory groups could not be loaded. Activity is complete; names, roles, and group filters are unavailable until a later request loads the directory.",
      },
    ];
  }
  return [];
}

function directoryProgress(directory: DirectorySnapshot) {
  return {
    status: directory.status,
    completedGroups: directory.progress?.completedGroups ?? 0,
    totalGroups: directory.progress?.totalGroups ?? null,
  };
}

/** Writes with backpressure and fails once the client has gone away. */
function responseWriter(response: Response): ChunkWriter {
  return (chunk) =>
    new Promise<void>((resolve, reject) => {
      if (response.destroyed || response.writableEnded) {
        reject(new Error("Response closed"));
        return;
      }
      if (response.write(chunk)) {
        resolve();
        return;
      }
      const cleanup = () => {
        response.off("drain", onDrain);
        response.off("close", onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Response closed"));
      };
      response.once("drain", onDrain);
      response.once("close", onClose);
    });
}

async function isRejected(promise: Promise<unknown>): Promise<boolean> {
  return promise.then(
    () => false,
    () => true,
  );
}

function publicCursorError(error: CursorApiError): string {
  if (error.status === 429) {
    return "Cursor API rate limit exceeded. Try again shortly.";
  }
  if (error.status === 400) return "Cursor API rejected the request.";
  if (error.status === 401 || error.status === 403) {
    return "Cursor rejected the API key.";
  }
  if (error.status === 504) return "Cursor API request timed out.";
  return "Could not load data from Cursor.";
}

export function createApp({
  client: initialClient,
  initialTeamMetadata,
  initialClientValidation,
  setup,
  staticDir,
  loadTeamMetadata = true,
  teamName = "",
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  cacheMaxRecords = DEFAULT_RUNTIME_SETTINGS.maxCachedRecords,
  maxEnrichedGroupAssignments = DEFAULT_RUNTIME_SETTINGS.maxEnrichedGroupAssignments,
  maxConcurrentAnalytics = DEFAULT_MAX_CONCURRENT_ANALYTICS,
  analyticsTimeoutMs = DEFAULT_RUNTIME_SETTINGS.analyticsTimeoutMs,
  directoryTimeoutMs = DEFAULT_RUNTIME_SETTINGS.directoryTimeoutMs,
  directoryGraceMs = DEFAULT_DIRECTORY_GRACE_MS,
  activityStore,
  loopbackOnly,
  shutdownSignal,
  defaultRangeDays = DEFAULT_RUNTIME_SETTINGS.defaultRangeDays,
  startupRanges,
}: AppOptions) {
  const app = express();
  let activeClient = initialClient ?? null;
  let clientReady = Boolean(initialClient && !initialClientValidation);
  let activeClientGeneration = initialClient ? 1 : 0;
  let configurationGeneration = 0;
  let configurationLock = Promise.resolve();
  let configurationController: AbortController | undefined;
  const cache = new Map<string, AnalyticsCacheEntry>();
  const refreshTimes = new Map<string, number>();
  const maxCacheEntries = Math.max(0, Math.floor(cacheMaxEntries));
  const maxCachedRecords = Math.max(0, Math.floor(cacheMaxRecords));
  const analyticsDeadlineMs = Math.max(1, Math.floor(analyticsTimeoutMs));
  const maxAnalyticsJobs = Math.max(1, Math.floor(maxConcurrentAnalytics));
  let activeAnalyticsJobs = 0;
  const enforceLoopback = loopbackOnly ?? Boolean(setup?.allowed);
  const teamMetadataCache = new TeamMetadataCache({
    enabled: loadTeamMetadata,
    ttlMs: cacheTtlMs,
    timeoutMs: Math.max(1, Math.floor(directoryTimeoutMs)),
    initialMetadata: initialTeamMetadata,
    shutdownSignal,
  });
  const parseSetupBody = express.json({
    limit: JSON_BODY_LIMIT,
    type: "application/json",
  });
  const apiKeyFrom = (body: unknown) => {
    const apiKey =
      isObject(body) && typeof body.apiKey === "string"
        ? body.apiKey.trim()
        : "";
    return apiKey && !/[\s\0]/.test(apiKey) ? apiKey : "";
  };
  const withConfigurationLock = <T>(action: () => Promise<T> | T) => {
    const result = configurationLock.then(action, action);
    configurationLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const holdEntry = (entry: AnalyticsCacheEntry) => {
    entry.holders += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holders -= 1;
      if (entry.holders === 0) {
        void entry.value.then(
          (dataset) => dataset.release(),
          () => undefined,
        );
      }
    };
  };
  const removeEntry = (
    key: string,
    entry: AnalyticsCacheEntry,
    abortReason?: string,
  ) => {
    if (cache.get(key) === entry) cache.delete(key);
    if (abortReason && !entry.settled) {
      entry.controller?.abort(new DOMException(abortReason, "AbortError"));
    }
    entry.releaseCacheHold?.();
    entry.releaseCacheHold = undefined;
  };
  const clearEntries = (reason: string) => {
    for (const [key, entry] of [...cache]) removeEntry(key, entry, reason);
  };
  const getClientSnapshot = (): ClientSnapshot | null =>
    activeClient
      ? { client: activeClient, generation: activeClientGeneration }
      : null;
  const isCurrentClient = ({ client, generation }: ClientSnapshot) =>
    activeClient === client && activeClientGeneration === generation;
  const invalidateClient = (snapshot: ClientSnapshot) => {
    if (!isCurrentClient(snapshot)) return false;
    activeClient = null;
    clientReady = false;
    activeClientGeneration += 1;
    clearEntries("API key invalidated");
    teamMetadataCache.clear("API key invalidated");
    return true;
  };
  const ensureDirectory = (snapshot: ClientSnapshot, now = Date.now()) => {
    teamMetadataCache.ensure(snapshot.client, now, (error) => {
      if (
        error instanceof CursorApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        invalidateClient(snapshot);
      }
    });
  };
  const applyApiKey = async (apiKey: string) => {
    if (!setup) throw new Error("API key configuration is unavailable.");
    const { attempt, controller } = await withConfigurationLock(() => {
      configurationController?.abort(
        new DOMException("Superseded API key validation", "AbortError"),
      );
      const nextController = new AbortController();
      configurationController = nextController;
      return {
        attempt: ++configurationGeneration,
        controller: nextController,
      };
    });
    let configured:
      CursorApiClient | { client: CursorApiClient; metadata: TeamMetadata };
    try {
      configured = await setup.configure(apiKey, controller.signal);
    } catch (error) {
      const superseded = await withConfigurationLock(
        () => attempt !== configurationGeneration,
      );
      if (superseded) return false;
      if (configurationController === controller) {
        configurationController = undefined;
      }
      throw error;
    }
    return withConfigurationLock(async () => {
      if (attempt !== configurationGeneration) return false;
      if (configurationController === controller) {
        configurationController = undefined;
      }
      await setup.persist?.(apiKey);
      // A cache failure only disables persistence; it must not block setup.
      await activityStore?.activate(apiKey).catch(() => undefined);
      activeClient =
        configured instanceof CursorApiClient ? configured : configured.client;
      clientReady = true;
      activeClientGeneration += 1;
      clearEntries("API key changed");
      teamMetadataCache.clear("API key changed");
      if (!(configured instanceof CursorApiClient)) {
        teamMetadataCache.seed(configured.metadata);
      }
      const snapshot = getClientSnapshot();
      if (snapshot) ensureDirectory(snapshot);
      return true;
    });
  };
  const pruneCache = (now: number, protectedEntry?: AnalyticsCacheEntry) => {
    for (const [key, refreshedAt] of refreshTimes) {
      if (now - refreshedAt >= REFRESH_COOLDOWN_MS) {
        refreshTimes.delete(key);
      }
    }
    for (const [key, entry] of [...cache]) {
      if (entry.expiresAt <= now) {
        if (!entry.settled && entry.subscribers > 0) continue;
        removeEntry(key, entry, "Analytics cache entry expired");
      }
    }
    while (cache.size > maxCacheEntries) {
      const oldest = [...cache].find(
        ([, entry]) =>
          entry !== protectedEntry &&
          (entry.settled || entry.subscribers === 0),
      );
      if (!oldest) break;
      removeEntry(oldest[0], oldest[1], "Analytics cache capacity exceeded");
    }
    let cachedRecords = [...cache.values()].reduce(
      (total, entry) => total + entry.recordCount,
      0,
    );
    while (cachedRecords > maxCachedRecords) {
      const oldest = [...cache].find(
        ([, entry]) => entry !== protectedEntry && entry.settled,
      );
      if (!oldest) break;
      const [oldestKey, oldestEntry] = oldest;
      removeEntry(oldestKey, oldestEntry);
      cachedRecords -= oldestEntry.recordCount;
    }
  };
  const cacheResponse = (key: string, entry: AnalyticsCacheEntry) => {
    if (maxCacheEntries === 0) return;
    const previous = cache.get(key);
    if (previous && previous !== entry) removeEntry(key, previous);
    cache.delete(key);
    cache.set(key, entry);
    entry.releaseCacheHold = holdEntry(entry);
    pruneCache(Date.now(), entry);
  };
  const createAnalyticsEntry = (
    snapshot: ClientSnapshot,
    startDate: string,
    endDate: string,
    now: number,
  ): AnalyticsCacheEntry => {
    if (activeAnalyticsJobs >= maxAnalyticsJobs) {
      throw new AnalyticsCapacityError();
    }
    activeAnalyticsJobs += 1;
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(analyticsDeadlineMs);
    const cancelSignal = AbortSignal.any([
      controller.signal,
      ...(shutdownSignal ? [shutdownSignal] : []),
    ]);
    const result = deferred<McpDataset>();
    const entry: AnalyticsCacheEntry = {
      controller,
      startedAt: now,
      expiresAt: now + cacheTtlMs,
      progress: { completedWindows: 0, totalWindows: 0 },
      progressEvents: [],
      progressListeners: new Set(),
      recordCount: 0,
      settled: false,
      subscribers: 0,
      holders: 0,
      value: result.promise,
    };
    const onProgress = (progress: McpFetchProgress) => {
      const previous = entry.progressEvents.at(-1);
      entry.progress = progress;
      // Late subscribers replay window-level steps; page updates only
      // replace the latest progress so the history stays bounded.
      if (
        !previous ||
        previous.completedWindows !== progress.completedWindows ||
        previous.totalWindows !== progress.totalWindows
      ) {
        entry.progressEvents.push(progress);
      }
      for (const listener of entry.progressListeners) listener();
    };
    ensureDirectory(snapshot, now);
    // Without disk storage, records are collected in memory.
    const analytics: Promise<McpDataset> = activityStore
      ? snapshot.client.fetchMcpDataset(startDate, endDate, {
          onProgress,
          signal: cancelSignal,
          deadline: timeoutSignal,
          deadlineMs: analyticsDeadlineMs,
          runs: activityStore,
        })
      : snapshot.client
          .fetchMcp(startDate, endDate, new Map(), onProgress, cancelSignal, {
            signal: timeoutSignal,
            milliseconds: analyticsDeadlineMs,
          })
          .then(datasetFromResponse);
    const operation = analytics
      .then((dataset) => {
        if (isCurrentClient(snapshot)) clientReady = true;
        entry.recordCount = dataset.recordCount;
        return dataset;
      })
      .catch(async (error: unknown) => {
        controller.abort(error);
        throw error;
      });
    void operation.then(result.resolve, result.reject);
    void entry.value.then(
      () => {
        activeAnalyticsJobs -= 1;
        entry.settled = true;
        entry.expiresAt = Date.now() + cacheTtlMs;
        entry.controller = undefined;
        pruneCache(Date.now());
      },
      () => {
        activeAnalyticsJobs -= 1;
        entry.settled = true;
        entry.controller = undefined;
      },
    );
    cacheResponse(`${startDate}:${endDate}`, entry);
    return entry;
  };
  const subscribeToEntry = (
    response: Response,
    key: string,
    entry: AnalyticsCacheEntry,
  ) => {
    entry.subscribers += 1;
    const releaseHold = holdEntry(entry);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers === 0 && !entry.settled) {
        removeEntry(key, entry, "All dashboard clients disconnected");
      }
      releaseHold();
    };
    response.once("close", release);
    return release;
  };
  /**
   * Finds or creates the entry for a range. Returns null after sending a 429
   * when a refresh of the same range was requested too recently.
   */
  const resolveEntry = (
    response: Response,
    snapshot: ClientSnapshot,
    startDate: string,
    endDate: string,
    forceRefresh: boolean,
  ): { key: string; entry: AnalyticsCacheEntry } | null => {
    const key = `${startDate}:${endDate}`;
    const now = Date.now();
    pruneCache(now);
    let existing = cache.get(key);
    if (existing?.controller?.signal.aborted) {
      removeEntry(key, existing);
      existing = undefined;
    }
    if (forceRefresh && existing?.settled) {
      const lastRefresh = refreshTimes.get(key);
      if (
        lastRefresh !== undefined &&
        now - lastRefresh < REFRESH_COOLDOWN_MS
      ) {
        response.status(429).json({
          error: "This date range was refreshed recently. Try again shortly.",
        });
        return null;
      }
      refreshTimes.set(key, now);
      removeEntry(key, existing);
      teamMetadataCache.invalidateForRefresh();
    }
    if (forceRefresh && !existing) refreshTimes.set(key, now);
    const cached = cache.get(key);
    return {
      key,
      entry: cached ?? createAnalyticsEntry(snapshot, startDate, endDate, now),
    };
  };
  /** Builds what a response needs once its dataset is ready. */
  const responseContext = async (
    snapshot: ClientSnapshot,
    dataset: McpDataset,
  ): Promise<ResponseContext> => {
    if (isCurrentClient(snapshot)) ensureDirectory(snapshot);
    if (!teamMetadataCache.snapshot().metadata) {
      await teamMetadataCache.waitForLoad(directoryGraceMs);
    }
    const directory = teamMetadataCache.snapshot();
    return {
      dataset,
      ...(directory.metadata ? { metadata: directory.metadata } : {}),
      teamName,
      maxEnrichedGroupAssignments,
      notices: directoryNotices(directory),
    };
  };
  if (initialClient && initialClientValidation) {
    const snapshot = getClientSnapshot();
    void initialClientValidation.then((validation) => {
      if (!snapshot || !isCurrentClient(snapshot)) return;
      if (validation.status === "invalid") {
        invalidateClient(snapshot);
        return;
      }
      if (validation.status === "valid") {
        clientReady = true;
        if (validation.metadata) {
          teamMetadataCache.seed(validation.metadata);
        }
        ensureDirectory(snapshot);
      }
    });
  }

  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=()",
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use("/api", (request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    if (!enforceLoopback) {
      next();
      return;
    }
    const origin = request.get("origin");
    if (
      !hasLoopbackAuthority(request.get("host")) ||
      (origin !== undefined && !hasLoopbackOrigin(origin)) ||
      request.get("sec-fetch-site") === "cross-site"
    ) {
      response.status(403).json({ error: "Loopback request rejected." });
      return;
    }
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, configured: Boolean(activeClient) });
  });

  const readiness = (_request: Request, response: Response) => {
    const configured = Boolean(activeClient && clientReady);
    response
      .status(configured ? 200 : 503)
      .json({ ok: configured, configured });
  };
  app.get("/api/ready", readiness);
  app.get("/api/health/ready", readiness);

  app.get("/api/setup/status", async (_request, response) => {
    // A preference that cannot be read only disables remembering it.
    const rangePreference = startupRanges
      ? await startupRanges.read().catch(() => null)
      : null;
    response.json({
      configured: Boolean(activeClient),
      setupAllowed: Boolean(setup?.allowed),
      defaultRangeDays,
      rangePreference,
      cacheCoverage: activityStore?.coverage?.() ?? null,
    });
  });

  app.put("/api/setup/range", parseSetupBody, async (request, response) => {
    const range = parseStartupRange(request.body);
    if (!range) {
      response.status(400).json({
        error:
          "Send a preset of 1 to 366 days or a custom range of at most 366 days.",
      });
      return;
    }
    if (!startupRanges) {
      response
        .status(503)
        .json({ error: "The startup range cannot be saved on this server." });
      return;
    }
    try {
      await startupRanges.write(range);
    } catch {
      response
        .status(503)
        .json({ error: "The startup range could not be saved." });
      return;
    }
    response.json({ rangePreference: range });
  });

  app.get("/api/directory/status", (_request, response) => {
    const snapshot = getClientSnapshot();
    if (snapshot && clientReady) ensureDirectory(snapshot);
    response.json(directoryProgress(teamMetadataCache.snapshot()));
  });

  app.post("/api/setup", parseSetupBody, async (request, response, next) => {
    try {
      if (activeClient) {
        response
          .status(409)
          .json({ error: "Dashboard is already configured." });
        return;
      }
      if (!setup?.allowed) {
        response.status(403).json({
          error:
            "Browser setup is available only on loopback. Run `npm run init` on the server.",
        });
        return;
      }
      const apiKey = apiKeyFrom(request.body);
      if (!apiKey) {
        response.status(400).json({ error: "Enter a valid API key." });
        return;
      }

      const applied = await applyApiKey(apiKey);
      if (!applied) {
        response.status(409).json(CONFIGURATION_SUPERSEDED_RESPONSE);
        return;
      }
      response.status(201).json({ configured: true });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/settings/api-key",
    parseSetupBody,
    async (request, response, next) => {
      try {
        if (!activeClient) {
          response.status(428).json({
            error: "Dashboard setup is required.",
            code: "SETUP_REQUIRED",
          });
          return;
        }
        if (!setup?.allowed) {
          response.status(403).json({
            error:
              "API key rotation is available only on loopback. Run `npm run init` on the server.",
          });
          return;
        }
        const apiKey = apiKeyFrom(request.body);
        if (!apiKey) {
          response.status(400).json({ error: "Enter a valid API key." });
          return;
        }

        const applied = await applyApiKey(apiKey);
        if (!applied) {
          response.status(409).json(CONFIGURATION_SUPERSEDED_RESPONSE);
          return;
        }
        response.json({ configured: true });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/mcp/stream", async (request, response, next) => {
    const snapshot = getClientSnapshot();
    if (!snapshot) {
      response.status(428).json({
        error: "Dashboard setup is required.",
        code: "SETUP_REQUIRED",
      });
      return;
    }
    let startDate: string;
    let endDate: string;
    try {
      ({ startDate, endDate } = validateDateRange(
        request.query.startDate,
        request.query.endDate,
      ));
    } catch (error) {
      next(error);
      return;
    }
    let resolved: ReturnType<typeof resolveEntry>;
    try {
      resolved = resolveEntry(
        response,
        snapshot,
        startDate,
        endDate,
        request.query.refresh === "1",
      );
    } catch (error) {
      if (error instanceof AnalyticsCapacityError) {
        response.status(200);
        response.setHeader(
          "Content-Type",
          "application/x-ndjson; charset=utf-8",
        );
        response.end(
          `${JSON.stringify({ type: "error", error: error.message })}\n`,
        );
        return;
      }
      next(error);
      return;
    }
    if (!resolved) return;
    const { key: cacheKey, entry: activeEntry } = resolved;

    response.status(200);
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    const send = (event: object) => {
      if (!response.writableEnded && !response.destroyed) {
        response.write(`${JSON.stringify(event)}\n`);
      }
    };
    let completedWindows = 0;
    let totalWindows = 0;
    let cachedDays = 0;
    let latestProgress: McpFetchProgress = activeEntry.progress;
    let progressLabel = "Starting";
    let progressDetail = "Connecting to Cursor";
    const progressStartedAt = Date.now();
    const rangeDays = daysBetween(startDate, endDate);
    const activity = (
      state: ActivityProgressEvent["state"],
      records = latestProgress.records ?? 0,
    ): ActivityProgressEvent => {
      const now = Date.now();
      const retry = state === "loading" ? latestProgress.retry : undefined;
      return {
        state,
        totalDays: rangeDays,
        cachedDays,
        fetchedDays:
          state === "loading"
            ? (latestProgress.fetchedDays ?? 0)
            : Math.max(0, rangeDays - cachedDays),
        records,
        completedWindows,
        totalWindows,
        windows:
          state === "loading" ? (latestProgress.activeWindows ?? []) : [],
        retry: retry
          ? {
              attempt: retry.attempt,
              maxAttempts: retry.maxAttempts,
              delayMs: retry.delayMs,
              waitedMs: Math.max(0, now - retry.startedAt),
              reason: retry.reason,
              status: retry.status ?? null,
            }
          : null,
        elapsedMs: Math.max(0, now - activeEntry.startedAt),
        idleMs:
          state === "loading"
            ? Math.max(
                0,
                now - (latestProgress.lastActivityAt ?? activeEntry.startedAt),
              )
            : 0,
      };
    };
    const progressEvent = (label: string, detail: string) => ({
      type: "progress",
      completed: completedWindows,
      total: totalWindows + 1,
      label,
      detail,
      directory: directoryProgress(teamMetadataCache.snapshot()),
      activity: activity(activeEntry.settled ? "reused" : "loading"),
    });
    const emitProgress = (label: string, detail: string) => {
      progressLabel = label;
      progressDetail = detail;
      send(progressEvent(label, detail));
    };
    const heartbeat = setInterval(() => {
      send(
        progressEvent(
          progressLabel,
          `${progressDetail} · ${Math.max(1, Math.round((Date.now() - progressStartedAt) / 1_000))}s elapsed`,
        ),
      );
    }, 2_000);
    heartbeat.unref();
    const stopDirectoryUpdates = teamMetadataCache.subscribe(() => {
      send(progressEvent(progressLabel, progressDetail));
    });
    response.once("close", () => {
      clearInterval(heartbeat);
      stopDirectoryUpdates();
    });

    const emitCurrentProgress = () => {
      if (activeEntry.settled) {
        emitProgress(
          "Cached activity",
          "Reusing the latest result for this date range",
        );
        return;
      }
      const cached =
        cachedDays > 0 ? ` · ${formatCount(cachedDays)} cached days` : "";
      emitProgress(
        "MCP activity",
        `${completedWindows} / ${totalWindows} date ranges${cached}`,
      );
    };
    const applyProgress = (progress: McpFetchProgress) => {
      latestProgress = progress;
      completedWindows = progress.completedWindows;
      totalWindows = progress.totalWindows;
      cachedDays = progress.cachedDays ?? 0;
    };
    const syncProgress = () => {
      applyProgress(activeEntry.progress);
      emitCurrentProgress();
    };
    activeEntry.progressListeners.add(syncProgress);
    const removeProgressListener = () => {
      activeEntry.progressListeners.delete(syncProgress);
    };
    response.once("close", removeProgressListener);
    const release = subscribeToEntry(response, cacheKey, activeEntry);
    try {
      if (activeEntry.settled || activeEntry.progressEvents.length === 0) {
        syncProgress();
      } else {
        for (const progress of activeEntry.progressEvents) {
          applyProgress(progress);
          emitCurrentProgress();
        }
        if (activeEntry.progress !== activeEntry.progressEvents.at(-1)) {
          syncProgress();
        }
      }
      const dataset = await activeEntry.value;
      removeProgressListener();
      completedWindows = totalWindows;
      const context = await responseContext(snapshot, dataset);
      send({
        type: "progress",
        completed: totalWindows + 1,
        total: totalWindows + 1,
        label: "Ready",
        detail: `${formatCount(dataset.recordCount)} activity rows`,
        directory: directoryProgress(teamMetadataCache.snapshot()),
        activity: activity("ready", dataset.recordCount),
      });
      clearInterval(heartbeat);
      stopDirectoryUpdates();
      await writeNdjsonResponse(responseWriter(response), context);
      if (isCurrentClient(snapshot)) {
        activeEntry.expiresAt = Date.now() + cacheTtlMs;
      }
      response.end();
    } catch (error) {
      removeProgressListener();
      clearInterval(heartbeat);
      stopDirectoryUpdates();
      if (!activeEntry.settled || (await isRejected(activeEntry.value))) {
        removeEntry(cacheKey, activeEntry);
      }
      if (response.destroyed) return;
      if (
        error instanceof CursorApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        if (invalidateClient(snapshot)) {
          send({
            type: "error",
            error:
              "The saved Cursor API key is no longer valid. Enter a new key to reconnect.",
            code: "SETUP_REQUIRED",
          });
        } else {
          send({ type: "error", error: publicCursorError(error) });
        }
      } else {
        send({
          type: "error",
          error:
            error instanceof CursorApiError
              ? publicCursorError(error)
              : "Could not load MCP analytics.",
        });
      }
      response.end();
    } finally {
      release();
    }
  });

  app.use("/api/mcp", (request, response, next) => {
    if (request.path !== "/") {
      next();
      return;
    }
    if (activeClient) {
      next();
      return;
    }
    response.status(428).json({
      error: "Dashboard setup is required.",
      code: "SETUP_REQUIRED",
    });
  });

  app.get("/api/mcp", async (request, response, next) => {
    try {
      const snapshot = getClientSnapshot();
      if (!snapshot) {
        response.status(428).json({
          error: "Dashboard setup is required.",
          code: "SETUP_REQUIRED",
        });
        return;
      }
      response.locals.clientSnapshot = snapshot;
      const { startDate, endDate } = validateDateRange(
        request.query.startDate,
        request.query.endDate,
      );
      const resolved = resolveEntry(
        response,
        snapshot,
        startDate,
        endDate,
        request.query.refresh === "1",
      );
      if (!resolved) return;
      const { key: cacheKey, entry } = resolved;
      const release = subscribeToEntry(response, cacheKey, entry);

      try {
        let dataset: McpDataset;
        try {
          dataset = await entry.value;
        } catch (error) {
          removeEntry(cacheKey, entry);
          throw error;
        }
        const context = await responseContext(snapshot, dataset);
        response.status(200);
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
          await writeJsonResponse(responseWriter(response), context);
          response.end();
        } catch {
          // Headers are sent, so a failure can only end the connection.
          response.destroy();
        }
      } finally {
        release();
      }
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API route not found." });
  });

  if (staticDir) {
    const absoluteStaticDir = path.resolve(staticDir);
    app.use(express.static(absoluteStaticDir, { index: "index.html" }));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/")) {
        next();
        return;
      }
      response.sendFile(path.join(absoluteStaticDir, "index.html"));
    });
  }

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (request.aborted || response.destroyed) return;
      if (error instanceof RangeError) {
        response.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof AnalyticsCapacityError) {
        response.setHeader("Retry-After", "1");
        response.status(503).json({ error: error.message });
        return;
      }
      const bodyError = isObject(error) ? error : {};
      if (bodyError.status === 413 || bodyError.type === "entity.too.large") {
        response.status(413).json({ error: "Request body is too large." });
        return;
      }
      if (
        bodyError.status === 400 &&
        bodyError.type === "entity.parse.failed"
      ) {
        response.status(400).json({ error: "Malformed JSON request body." });
        return;
      }
      if (error instanceof CursorApiError) {
        if (
          request.path !== "/api/setup" &&
          request.path !== "/api/settings/api-key" &&
          (error.status === 401 || error.status === 403) &&
          isClientSnapshot(response.locals.clientSnapshot) &&
          invalidateClient(response.locals.clientSnapshot)
        ) {
          response.status(428).json({
            error:
              "The saved Cursor API key is no longer valid. Enter a new key to reconnect.",
            code: "SETUP_REQUIRED",
          });
          return;
        }
        const publicStatus =
          error.status === 401 ||
          error.status === 403 ||
          error.status === 429 ||
          error.status === 504
            ? error.status
            : 502;
        response.status(publicStatus).json({ error: publicCursorError(error) });
        return;
      }

      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          event: "request.unexpected_error",
          method: request.method,
          path: request.path,
        }),
      );
      response.status(500).json({ error: "Unexpected server error" });
    },
  );

  return app;
}
