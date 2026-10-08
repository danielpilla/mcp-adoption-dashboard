import { describe, expect, it, vi } from "vitest";
import { CursorApiClient, type TeamMetadata } from "./cursor-api";
import { TeamMetadataCache } from "./team-metadata-cache";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function metadata(name: string): TeamMetadata {
  return {
    users: new Map([
      [
        "user-1@example.com",
        {
          name,
          role: "member",
          directoryGroups: ["group-1"],
        },
      ],
    ]),
    memberCount: 1,
    groupNames: ["group-1"],
  };
}

describe("team metadata cache", () => {
  it("reports disabled without calling Cursor when disabled", () => {
    const client = new CursorApiClient("test-key");
    const fetchTeamMetadata = vi.spyOn(client, "fetchTeamMetadata");
    const cache = new TeamMetadataCache({
      enabled: false,
      ttlMs: 100,
      timeoutMs: 100,
    });

    cache.ensure(client, 0);

    expect(cache.snapshot()).toEqual({ status: "disabled" });
    expect(fetchTeamMetadata).not.toHaveBeenCalled();
  });

  it("loads in the background and reports progress until ready", async () => {
    const pending = deferred<TeamMetadata>();
    const client = new CursorApiClient("test-key");
    let reportProgress:
      | ((progress: { completedGroups: number; totalGroups?: number }) => void)
      | undefined;
    vi.spyOn(client, "fetchTeamMetadata").mockImplementation(
      async (_signal, onProgress) => {
        reportProgress = onProgress;
        return pending.promise;
      },
    );
    const cache = new TeamMetadataCache({
      enabled: true,
      ttlMs: 1_000,
      timeoutMs: 1_000,
    });
    const listener = vi.fn();
    cache.subscribe(listener);

    cache.ensure(client, 0);
    expect(cache.snapshot()).toEqual({ status: "loading" });
    reportProgress?.({ completedGroups: 2, totalGroups: 5 });
    expect(cache.snapshot()).toEqual({
      status: "loading",
      progress: { completedGroups: 2, totalGroups: 5 },
    });
    expect(listener).toHaveBeenCalled();

    pending.resolve(metadata("Loaded"));
    await cache.waitForLoad(1_000);
    expect(cache.snapshot().status).toBe("ready");
    expect(
      cache.snapshot().metadata?.users.get("user-1@example.com")?.name,
    ).toBe("Loaded");
  });

  it("passes the directory deadline to the load", () => {
    const client = new CursorApiClient("test-key");
    const fetchTeamMetadata = vi
      .spyOn(client, "fetchTeamMetadata")
      .mockImplementation(async () => new Promise<TeamMetadata>(() => {}));
    const cache = new TeamMetadataCache({
      enabled: true,
      ttlMs: 1_000,
      timeoutMs: 4_321,
    });

    cache.ensure(client, 0);

    const [, , deadline, deadlineMs] = fetchTeamMetadata.mock.calls[0];
    expect(deadline).toBeInstanceOf(AbortSignal);
    expect(deadlineMs).toBe(4_321);
  });

  it("shares active metadata work across range refreshes", () => {
    let signal: AbortSignal | undefined;
    const client = new CursorApiClient("test-key");
    const fetchTeamMetadata = vi
      .spyOn(client, "fetchTeamMetadata")
      .mockImplementation(async (nextSignal) => {
        signal = nextSignal;
        return new Promise<TeamMetadata>(() => {});
      });
    const cache = new TeamMetadataCache({
      enabled: true,
      ttlMs: 100,
      timeoutMs: 1_000,
    });

    cache.ensure(client, 0);
    cache.invalidateForRefresh();
    cache.ensure(client, 1);

    expect(signal?.aborted).toBe(false);
    expect(fetchTeamMetadata).toHaveBeenCalledOnce();
  });

  it("keeps stale metadata available while a refresh loads", async () => {
    const refreshed = deferred<TeamMetadata>();
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchTeamMetadata").mockImplementation(
      async () => refreshed.promise,
    );
    const cache = new TeamMetadataCache({
      enabled: true,
      ttlMs: 100,
      timeoutMs: 1_000,
      initialMetadata: metadata("Stale"),
    });

    cache.invalidateForRefresh();
    cache.ensure(client, Date.now());

    expect(cache.snapshot().status).toBe("loading");
    expect(
      cache.snapshot().metadata?.users.get("user-1@example.com")?.name,
    ).toBe("Stale");
    refreshed.resolve(metadata("Fresh"));
    await cache.waitForLoad(1_000);
    expect(
      cache.snapshot().metadata?.users.get("user-1@example.com")?.name,
    ).toBe("Fresh");
  });

  it("does not let an invalidated load replace newer metadata", async () => {
    const oldResult = deferred<TeamMetadata>();
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchTeamMetadata")
      .mockImplementationOnce(async () => oldResult.promise)
      .mockResolvedValueOnce(metadata("Fresh"));
    const cache = new TeamMetadataCache({
      enabled: true,
      ttlMs: 100_000,
      timeoutMs: 1_000,
    });

    cache.ensure(client, 0);
    cache.clear("replace");
    cache.ensure(client, 1);
    await cache.waitForLoad(1_000);

    oldResult.resolve(metadata("Old"));
    await Promise.resolve();
    await Promise.resolve();

    expect(
      cache.snapshot().metadata?.users.get("user-1@example.com")?.name,
    ).toBe("Fresh");
  });

  it("reports failures and lets a later request retry", async () => {
    const client = new CursorApiClient("test-key");
    const fetchTeamMetadata = vi
      .spyOn(client, "fetchTeamMetadata")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(metadata("Recovered"));
    const cache = new TeamMetadataCache({
      enabled: true,
      ttlMs: 1_000,
      timeoutMs: 1_000,
    });
    const onError = vi.fn();

    cache.ensure(client, 0, onError);
    await cache.waitForLoad(1_000);
    expect(cache.snapshot()).toEqual({ status: "failed" });
    expect(onError).toHaveBeenCalledOnce();

    cache.ensure(client, 1);
    await cache.waitForLoad(1_000);
    expect(cache.snapshot().status).toBe("ready");
    expect(fetchTeamMetadata).toHaveBeenCalledTimes(2);
  });
});
