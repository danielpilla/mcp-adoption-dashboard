import {
  CursorApiClient,
  type TeamMetadata,
  type TeamMetadataProgress,
} from "./cursor-api.js";

export interface TeamMetadataLoad {
  value: Promise<TeamMetadata>;
  generation: number;
}

interface TeamMetadataCacheOptions {
  enabled: boolean;
  ttlMs: number;
  timeoutMs: number;
  initialMetadata?: TeamMetadata;
  shutdownSignal?: AbortSignal;
}

interface CacheEntry extends TeamMetadataLoad {
  expiresAt: number;
}

function emptyTeamMetadata(): TeamMetadata {
  return {
    users: new Map(),
    memberCount: 0,
    groupNames: [],
  };
}

export class TeamMetadataCache {
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly shutdownSignal?: AbortSignal;
  private controller?: AbortController;
  private generation = 0;
  private entry: CacheEntry | null;

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
    this.entry = initialMetadata
      ? this.resolvedEntry(initialMetadata, Date.now())
      : null;
  }

  clear(reason: string): void {
    this.generation += 1;
    this.controller?.abort(new DOMException(reason, "AbortError"));
    this.controller = undefined;
    this.entry = null;
  }

  seed(metadata: TeamMetadata, now = Date.now()): void {
    this.entry = this.resolvedEntry(metadata, now);
  }

  invalidateForRefresh(reason: string): void {
    // Metadata is global to the team. A concurrent range refresh should share
    // active work rather than aborting requests that already depend on it.
    if (!this.controller) this.clear(reason);
  }

  load(
    client: CursorApiClient,
    now: number,
    onProgress?: (progress: TeamMetadataProgress) => void,
  ): TeamMetadataLoad {
    if (!this.enabled) {
      return {
        value: Promise.resolve(emptyTeamMetadata()),
        generation: this.generation,
      };
    }
    if (!this.entry || this.entry.expiresAt <= now) {
      this.clear("Team metadata cache expired");
      const controller = new AbortController();
      this.controller = controller;
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = AbortSignal.any([
        controller.signal,
        timeoutSignal,
        ...(this.shutdownSignal ? [this.shutdownSignal] : []),
      ]);
      const value = client.fetchTeamMetadata(signal, onProgress);
      const entry: CacheEntry = {
        value,
        expiresAt: now + this.ttlMs,
        generation: this.generation,
      };
      this.entry = entry;
      void value
        .catch(() => {
          if (this.entry === entry) this.entry = null;
        })
        .finally(() => {
          if (this.controller === controller) this.controller = undefined;
        });
    }
    return this.entry;
  }

  commit(
    load: TeamMetadataLoad,
    metadata: TeamMetadata,
    now = Date.now(),
  ): void {
    if (load.generation !== this.generation) return;
    this.entry = this.resolvedEntry(metadata, now);
  }

  private resolvedEntry(metadata: TeamMetadata, now: number): CacheEntry {
    return {
      value: Promise.resolve(metadata),
      expiresAt: now + this.ttlMs,
      generation: this.generation,
    };
  }
}
