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
        "user@example.test",
        {
          name,
          role: "member",
          directoryGroups: ["Engineering"],
        },
      ],
    ]),
    memberCount: 1,
    groupNames: ["Engineering"],
  };
}

describe("team metadata cache", () => {
  it("returns empty metadata without calling Cursor when disabled", async () => {
    const client = new CursorApiClient("test-key");
    const fetchTeamMetadata = vi.spyOn(client, "fetchTeamMetadata");
    const cache = new TeamMetadataCache({
      enabled: false,
      ttlMs: 100,
      timeoutMs: 100,
    });

    await expect(cache.load(client, 0).value).resolves.toEqual({
      users: new Map(),
      memberCount: 0,
      groupNames: [],
    });
    expect(fetchTeamMetadata).not.toHaveBeenCalled();
  });

  it("shares active metadata work across range refreshes", async () => {
    const pending = deferred<TeamMetadata>();
    let signal: AbortSignal | undefined;
    const client = new CursorApiClient("test-key");
    const fetchTeamMetadata = vi
      .spyOn(client, "fetchTeamMetadata")
      .mockImplementation(async (nextSignal) => {
        signal = nextSignal;
        return pending.promise;
      });
    const cache = new TeamMetadataCache({
      enabled: true,
      ttlMs: 100,
      timeoutMs: 1_000,
    });

    const first = cache.load(client, 0);
    cache.invalidateForRefresh("refresh");
    const second = cache.load(client, 1);

    expect(second.value).toBe(first.value);
    expect(signal?.aborted).toBe(false);
    expect(fetchTeamMetadata).toHaveBeenCalledOnce();

    pending.resolve(metadata("Shared"));
    const result = await first.value;
    cache.commit(first, result, 2);
    await expect(cache.load(client, 3).value).resolves.toEqual(result);
  });

  it("does not let an invalidated load replace newer metadata", async () => {
    const oldResult = deferred<TeamMetadata>();
    const client = new CursorApiClient("test-key");
    vi.spyOn(client, "fetchTeamMetadata")
      .mockImplementationOnce(async () => oldResult.promise)
      .mockResolvedValueOnce(metadata("Fresh"));
    const cache = new TeamMetadataCache({
      enabled: true,
      ttlMs: 100,
      timeoutMs: 1_000,
    });

    const oldLoad = cache.load(client, 0);
    cache.clear("replace");
    const freshLoad = cache.load(client, 1);
    const fresh = await freshLoad.value;
    cache.commit(freshLoad, fresh, 2);

    oldResult.resolve(metadata("Old"));
    cache.commit(oldLoad, await oldLoad.value, 3);

    const cached = await cache.load(client, 4).value;
    expect(cached.users.get("user@example.test")?.name).toBe("Fresh");
  });
});
