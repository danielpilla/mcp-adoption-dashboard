import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import path from "node:path";
import type { McpResponse } from "../../contracts/mcp-response.js";
import {
  CursorApiClient,
  CursorApiError,
  DEFAULT_CURSOR_API_LIMITS,
  enrichMcpResponse,
  type TeamMetadata,
  type TeamMetadataProgress,
} from "../cursor/cursor-api.js";
import { isLoopbackHost } from "../configuration/server-configuration.js";
import { validateDateRange } from "../analytics/analytics-date-range.js";
import { TeamMetadataCache } from "../cursor/team-metadata-cache.js";

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
  loopbackOnly?: boolean;
  shutdownSignal?: AbortSignal;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

interface AnalyticsCacheEntry extends CacheEntry<McpResponse> {
  controller?: AbortController;
  metadataProgress?: TeamMetadataProgress;
  progress: { completedWindows: number; totalWindows: number };
  progressEvents: Array<
    | {
        kind: "analytics";
        progress: { completedWindows: number; totalWindows: number };
      }
    | { kind: "metadata"; progress: TeamMetadataProgress }
  >;
  progressListeners: Set<() => void>;
  recordCount: number;
  settled: boolean;
  subscribers: number;
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
const DEFAULT_CACHE_MAX_RECORDS = 1_000_000;
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60_000;
const DEFAULT_MAX_CONCURRENT_ANALYTICS = 4;
const DEFAULT_ANALYTICS_TIMEOUT_MS = 5 * 60_000;
const REFRESH_COOLDOWN_MS = 10_000;
const JSON_BODY_LIMIT = "4kb";
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
  cacheMaxRecords = DEFAULT_CACHE_MAX_RECORDS,
  maxEnrichedGroupAssignments = DEFAULT_CURSOR_API_LIMITS.maxEnrichedGroupAssignments,
  maxConcurrentAnalytics = DEFAULT_MAX_CONCURRENT_ANALYTICS,
  analyticsTimeoutMs = DEFAULT_ANALYTICS_TIMEOUT_MS,
  loopbackOnly,
  shutdownSignal,
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
    timeoutMs: analyticsDeadlineMs,
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
      activeClient =
        configured instanceof CursorApiClient ? configured : configured.client;
      clientReady = true;
      activeClientGeneration += 1;
      for (const entry of cache.values()) {
        entry.controller?.abort(
          new DOMException("API key changed", "AbortError"),
        );
      }
      cache.clear();
      teamMetadataCache.clear("API key changed");
      if (!(configured instanceof CursorApiClient)) {
        teamMetadataCache.seed(configured.metadata);
      }
      return true;
    });
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
    for (const entry of cache.values()) {
      entry.controller?.abort(
        new DOMException("API key invalidated", "AbortError"),
      );
    }
    cache.clear();
    teamMetadataCache.clear("API key invalidated");
    return true;
  };
  const pruneCache = (now: number, protectedEntry?: AnalyticsCacheEntry) => {
    for (const [key, refreshedAt] of refreshTimes) {
      if (now - refreshedAt >= REFRESH_COOLDOWN_MS) {
        refreshTimes.delete(key);
      }
    }
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) {
        if (!entry.settled && entry.subscribers > 0) continue;
        cache.delete(key);
        if (!entry.settled) {
          entry.controller?.abort(
            new DOMException("Analytics cache entry expired", "AbortError"),
          );
        }
      }
    }
    while (cache.size > maxCacheEntries) {
      const oldest = [...cache].find(
        ([, entry]) =>
          entry !== protectedEntry &&
          (entry.settled || entry.subscribers === 0),
      );
      if (!oldest) break;
      const [oldestKey, oldestEntry] = oldest;
      cache.delete(oldestKey);
      if (!oldestEntry.settled) {
        oldestEntry.controller?.abort(
          new DOMException("Analytics cache capacity exceeded", "AbortError"),
        );
      }
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
      cache.delete(oldestKey);
      cachedRecords -= oldestEntry.recordCount;
    }
  };
  const cacheResponse = (key: string, entry: AnalyticsCacheEntry) => {
    if (maxCacheEntries === 0) return;
    cache.delete(key);
    cache.set(key, entry);
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
    const signal = AbortSignal.any([
      controller.signal,
      timeoutSignal,
      ...(shutdownSignal ? [shutdownSignal] : []),
    ]);
    const result = deferred<McpResponse>();
    const entry: AnalyticsCacheEntry = {
      controller,
      expiresAt: now + cacheTtlMs,
      progress: { completedWindows: 0, totalWindows: 0 },
      progressEvents: [],
      progressListeners: new Set(),
      recordCount: 0,
      settled: false,
      subscribers: 0,
      value: result.promise,
    };
    const notifyProgress = () => {
      for (const listener of entry.progressListeners) listener();
    };
    const metadataEntry = teamMetadataCache.load(
      snapshot.client,
      now,
      (progress) => {
        entry.metadataProgress = progress;
        entry.progressEvents.push({ kind: "metadata", progress });
        notifyProgress();
      },
    );
    const metadata = metadataEntry.value;
    const analytics = snapshot.client.fetchMcp(
      startDate,
      endDate,
      new Map(),
      (progress) => {
        entry.progress = progress;
        entry.progressEvents.push({ kind: "analytics", progress });
        notifyProgress();
      },
      signal,
    );
    const operation = Promise.all([analytics, metadata])
      .then(([mcp, teamDetails]) => {
        if (isCurrentClient(snapshot)) {
          clientReady = true;
          teamMetadataCache.commit(metadataEntry, teamDetails);
        }
        const result = enrichMcpResponse(
          mcp,
          teamDetails,
          teamName,
          maxEnrichedGroupAssignments,
        );
        entry.recordCount = result.records.length;
        return result;
      })
      .catch(async (error: unknown) => {
        controller.abort(error);
        await Promise.allSettled([analytics]);
        if (timeoutSignal.aborted && !shutdownSignal?.aborted) {
          throw new CursorApiError("Analytics request timed out", 504);
        }
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
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers === 0 && !entry.settled) {
        if (cache.get(key) === entry) cache.delete(key);
        entry.controller?.abort(
          new DOMException("All dashboard clients disconnected", "AbortError"),
        );
      }
    };
    response.once("close", release);
    return release;
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

  app.get("/api/setup/status", (_request, response) => {
    response.json({
      configured: Boolean(activeClient),
      setupAllowed: Boolean(setup?.allowed),
    });
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
    let metadataComplete = !loadTeamMetadata;
    let metadataFraction = metadataComplete ? 1 : 0;
    let metadataDetail = "Loading team members and directory groups";
    let progressLabel = "Starting";
    let progressDetail = "Connecting to Cursor";
    const progressStartedAt = Date.now();
    const emitProgress = (label: string, detail: string) => {
      progressLabel = label;
      progressDetail = detail;
      send({
        type: "progress",
        completed: completedWindows + metadataFraction,
        total: totalWindows + 2,
        label,
        detail,
      });
    };
    const heartbeat = setInterval(() => {
      send({
        type: "progress",
        completed: completedWindows + metadataFraction,
        total: totalWindows + 2,
        label: progressLabel,
        detail: `${progressDetail} · ${Math.max(1, Math.round((Date.now() - progressStartedAt) / 1_000))}s elapsed`,
      });
    }, 2_000);
    heartbeat.unref();
    response.once("close", () => {
      clearInterval(heartbeat);
    });

    const cacheKey = `${startDate}:${endDate}`;
    const now = Date.now();
    pruneCache(now);
    let entry = cache.get(cacheKey);
    if (entry?.controller?.signal.aborted) {
      cache.delete(cacheKey);
      entry = undefined;
    }
    let removeProgressListener = () => undefined;
    try {
      if (!entry) {
        entry = createAnalyticsEntry(snapshot, startDate, endDate, now);
      }
      const activeEntry = entry;
      const applyMetadataProgress = (
        metadataProgress: TeamMetadataProgress | undefined,
      ) => {
        if (metadataProgress?.totalGroups === undefined) return;
        const totalGroups = metadataProgress.totalGroups;
        metadataFraction =
          totalGroups === 0
            ? 1
            : metadataProgress.completedGroups / totalGroups;
        metadataDetail =
          totalGroups === 0
            ? "No directory groups to enrich"
            : `${metadataProgress.completedGroups} / ${totalGroups} directory groups`;
      };
      const emitCurrentProgress = () => {
        if (activeEntry.settled) {
          emitProgress(
            "Cached activity",
            "Reusing the latest result for this date range",
          );
        } else if (
          totalWindows > 0 &&
          completedWindows === totalWindows &&
          !metadataComplete
        ) {
          emitProgress("Team metadata", metadataDetail);
        } else {
          emitProgress(
            "MCP activity",
            `${completedWindows} / ${totalWindows} date ranges`,
          );
        }
      };
      const syncProgress = () => {
        completedWindows = activeEntry.progress.completedWindows;
        totalWindows = activeEntry.progress.totalWindows;
        applyMetadataProgress(activeEntry.metadataProgress);
        emitCurrentProgress();
      };
      activeEntry.progressListeners.add(syncProgress);
      const removeListener = () => {
        activeEntry.progressListeners.delete(syncProgress);
      };
      response.once("close", removeListener);
      removeProgressListener = () => {
        response.off("close", removeListener);
        removeListener();
      };
      if (activeEntry.settled || activeEntry.progressEvents.length === 0) {
        syncProgress();
      } else {
        for (const event of activeEntry.progressEvents) {
          if (event.kind === "analytics") {
            completedWindows = event.progress.completedWindows;
            totalWindows = event.progress.totalWindows;
          } else {
            applyMetadataProgress(event.progress);
          }
          emitCurrentProgress();
        }
      }
      const release = subscribeToEntry(response, cacheKey, activeEntry);
      const result = await activeEntry.value;
      release();
      removeProgressListener();
      metadataComplete = true;
      metadataFraction = 1;
      send({
        type: "progress",
        completed: totalWindows + 2,
        total: totalWindows + 2,
        label: "Ready",
        detail: `${result.records.length.toLocaleString()} activity rows`,
      });
      send({ type: "data", data: result });
      if (isCurrentClient(snapshot)) {
        activeEntry.expiresAt = Date.now() + cacheTtlMs;
      }
      clearInterval(heartbeat);
      response.end();
    } catch (error) {
      removeProgressListener();
      if (entry && cache.get(cacheKey) === entry) cache.delete(cacheKey);
      if (response.destroyed) {
        clearInterval(heartbeat);
        return;
      }
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
            error instanceof AnalyticsCapacityError
              ? error.message
              : error instanceof CursorApiError
                ? publicCursorError(error)
                : "Could not load MCP analytics.",
        });
      }
      clearInterval(heartbeat);
      response.end();
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
      const cacheKey = `${startDate}:${endDate}`;
      const forceRefresh = request.query.refresh === "1";
      const now = Date.now();
      pruneCache(now);
      let existing = cache.get(cacheKey);
      if (existing?.controller?.signal.aborted) {
        cache.delete(cacheKey);
        existing = undefined;
      }
      if (forceRefresh && existing?.settled) {
        const lastRefresh = refreshTimes.get(cacheKey);
        if (
          lastRefresh !== undefined &&
          now - lastRefresh < REFRESH_COOLDOWN_MS
        ) {
          response.status(429).json({
            error: "This date range was refreshed recently. Try again shortly.",
          });
          return;
        }
        refreshTimes.set(cacheKey, now);
        cache.delete(cacheKey);
        teamMetadataCache.invalidateForRefresh("Analytics refresh requested");
      }
      if (forceRefresh && !existing) refreshTimes.set(cacheKey, now);
      const cached = cache.get(cacheKey);
      const entry =
        cached ?? createAnalyticsEntry(snapshot, startDate, endDate, now);
      const release = subscribeToEntry(response, cacheKey, entry);

      try {
        response.json(await entry.value);
      } catch (error) {
        if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
        throw error;
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
