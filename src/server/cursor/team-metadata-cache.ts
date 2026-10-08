import {
  CursorApiClient,
  type TeamMetadata,
  type TeamMetadataProgress,
} from "./cursor-api.js";

type DirectoryStatus = "disabled" | "idle" | "loading" | "ready" | "failed";

export interface DirectorySnapshot {
  status: DirectoryStatus;
  /** The latest loaded directory, kept while a refresh is in progress. */
  metadata?: TeamMetadata;
  progress?: TeamMetadataProgress;
}

interface TeamMetadataCacheOptions {
  enabled: boolean;
  ttlMs: number;
  /** Directory loads stop at this deadline and keep what was loaded. */
  timeoutMs: number;
  initialMetadata?: TeamMetadata;
  shutdownSignal?: AbortSignal;
}

interface ActiveLoad {
  controller: AbortController;
  promise: Promise<void>;
  progress?: TeamMetadataProgress;
}

/**
 * Loads team members, directory groups, and memberships in the background.
 * Callers read the latest snapshot instead of waiting, so analytics never
 * block on a large directory. Expired metadata stays available until a
 * replacement finishes loading.
 */
export class TeamMetadataCache {
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly shutdownSignal?: AbortSignal;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private metadata?: TeamMetadata;
  private expiresAt = 0;
  private failed = false;
  private active?: ActiveLoad;

  constructor({
    enabled,
    ttlMs,
    timeoutMs,
    initialMetadata,
    shutdownSignal,
  }: TeamMetadataCacheOptions) {
    this.enabled = enabled;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.shutdownSignal = shutdownSignal;
    if (initialMetadata) this.seed(initialMetadata);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(reason: string): void {
    this.generation += 1;
    this.active?.controller.abort(new DOMException(reason, "AbortError"));
    this.active = undefined;
    this.metadata = undefined;
    this.expiresAt = 0;
    this.failed = false;
    this.notify();
  }

  seed(metadata: TeamMetadata, now = Date.now()): void {
    this.metadata = metadata;
    this.expiresAt = now + this.ttlMs;
    this.failed = false;
    this.notify();
  }

  /** Marks loaded metadata stale; an active load is shared, not restarted. */
  invalidateForRefresh(): void {
    if (!this.active) this.expiresAt = 0;
  }

  snapshot(): DirectorySnapshot {
    if (!this.enabled) return { status: "disabled" };
    const metadata = this.metadata ? { metadata: this.metadata } : {};
    if (this.active) {
      return {
        status: "loading",
        ...metadata,
        ...(this.active.progress ? { progress: this.active.progress } : {}),
      };
    }
    if (this.metadata) return { status: "ready", ...metadata };
    return { status: this.failed ? "failed" : "idle" };
  }

  /**
   * Starts a background load unless current metadata is fresh or a load is
   * already running. `onError` receives load failures for this client.
   */
  ensure(
    client: CursorApiClient,
    now = Date.now(),
    onError?: (error: unknown) => void,
  ): void {
    if (!this.enabled || this.active) return;
    if (this.metadata && this.expiresAt > now) return;
    const generation = this.generation;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(this.shutdownSignal ? [this.shutdownSignal] : []),
    ]);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const load: ActiveLoad = { controller, promise: Promise.resolve() };
    this.active = load;
    this.failed = false;
    load.promise = client
      .fetchTeamMetadata(
        signal,
        (progress) => {
          if (this.active !== load) return;
          load.progress = progress;
          this.notify();
        },
        deadline,
        this.timeoutMs,
      )
      .then(
        (metadata) => {
          if (this.generation !== generation) return;
          this.metadata = metadata;
          this.expiresAt = Date.now() + this.ttlMs;
        },
        (error: unknown) => {
          if (this.generation !== generation || signal.aborted) return;
          this.failed = true;
          onError?.(error);
        },
      )
      .finally(() => {
        if (this.active === load) this.active = undefined;
        this.notify();
      });
  }

  /** Waits up to `milliseconds` for an active load to finish. */
  async waitForLoad(milliseconds: number): Promise<void> {
    const active = this.active;
    if (!active || milliseconds <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      active.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
