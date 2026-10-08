import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorApiClient } from "../cursor/cursor-api";
import type { McpDataset } from "../cursor/mcp-collection";
import { McpDayCache } from "./mcp-day-cache";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createCache(
  options: { maxBytes?: number; refetchDays?: number } = {},
): Promise<{ cache: McpDayCache; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-day-cache-"));
  directories.push(directory);
  const cache = new McpDayCache({
    directory,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    refetchDays: options.refetchDays ?? 2,
    now: () => new Date("2026-09-20T12:00:00Z"),
  });
  await cache.open();
  await cache.activate("key-a");
  return { cache, directory };
}

function datesBetween(startDate: string, endDate: string): string[] {
  const dates = [];
  for (
    let date = new Date(`${startDate}T00:00:00Z`);
    date <= new Date(`${endDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

/** Answers every window with one record per day. */
function createClient(limits: { maxRecords?: number } = {}) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    const dates = datesBetween(
      url.searchParams.get("startDate") ?? "",
      url.searchParams.get("endDate") ?? "",
    );
    return new Response(
      JSON.stringify({
        data: {
          "user-1@example.com": dates.map((date) => ({
            event_date: date,
            tool_name: "tool-1",
            mcp_server_name: "server-1",
            usage: 1,
          })),
        },
        pagination: { hasNextPage: false },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const client = new CursorApiClient(
    "key-a",
    "https://example.test",
    fetcher,
    undefined,
    "",
    undefined,
    limits,
  );
  return { client, fetcher };
}

function requestedWindows(fetcher: ReturnType<typeof createClient>["fetcher"]) {
  return fetcher.mock.calls.map(([input]) => {
    const url = new URL(String(input));
    return [url.searchParams.get("startDate"), url.searchParams.get("endDate")];
  });
}

async function readDates(dataset: McpDataset): Promise<string[]> {
  const dates = [];
  for await (const day of dataset.readDays("ascending")) {
    for (const record of day.records) dates.push(record.date);
  }
  return dates;
}

async function load(
  client: CursorApiClient,
  cache: McpDayCache,
  startDate = "2026-09-01",
  endDate = "2026-09-20",
): Promise<string[]> {
  const dataset = await client.fetchMcpDataset(startDate, endDate, {
    runs: cache,
  });
  try {
    return await readDates(dataset);
  } finally {
    dataset.release();
  }
}

async function persistedDates(directory: string): Promise<string[]> {
  return (await readdir(join(directory, "days")))
    .map((name) => name.replace(".ndjson", ""))
    .sort();
}

describe("MCP day cache", () => {
  it("fetches only days that are not cached on reload", async () => {
    const { cache } = await createCache();
    const { client, fetcher } = createClient();

    expect(await load(client, cache)).toEqual(
      datesBetween("2026-09-01", "2026-09-20"),
    );
    fetcher.mockClear();
    expect(await load(client, cache)).toEqual(
      datesBetween("2026-09-01", "2026-09-20"),
    );

    expect(requestedWindows(fetcher)).toEqual([["2026-09-18", "2026-09-20"]]);
  });

  it("never persists today or the configured refetch days", async () => {
    const { cache, directory } = await createCache({ refetchDays: 4 });
    const { client } = createClient();

    await load(client, cache);

    expect(await persistedDates(directory)).toEqual(
      datesBetween("2026-09-01", "2026-09-15"),
    );
  });

  it("reuses cached days for an overlapping range", async () => {
    const { cache } = await createCache();
    const { client, fetcher } = createClient();

    await load(client, cache, "2026-09-05", "2026-09-10");
    fetcher.mockClear();
    await load(client, cache, "2026-09-01", "2026-09-12");

    expect(requestedWindows(fetcher)).toEqual(
      expect.arrayContaining([
        ["2026-09-11", "2026-09-12"],
        ["2026-09-01", "2026-09-04"],
      ]),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ignores a corrupt day file and refetches that day", async () => {
    const { cache, directory } = await createCache();
    const { client, fetcher } = createClient();
    await load(client, cache);
    const path = join(directory, "days", "2026-09-05.ndjson");
    await writeFile(path, "not a day file\n");
    fetcher.mockClear();

    expect(await load(client, cache)).toEqual(
      datesBetween("2026-09-01", "2026-09-20"),
    );

    expect(requestedWindows(fetcher)).toEqual(
      expect.arrayContaining([["2026-09-05", "2026-09-05"]]),
    );
    expect(await readFile(path, "utf8")).toContain('"date":"2026-09-05"');
  });

  it("reports coverage of the cacheable days from its index", async () => {
    const { cache, directory } = await createCache();
    const { client } = createClient();

    expect(cache.coverage()).toEqual({
      firstDate: null,
      lastDate: null,
      days: 0,
      cacheableThrough: "2026-09-17",
      spans: [],
    });

    await load(client, cache, "2026-08-25", "2026-08-31");
    await load(client, cache, "2026-09-10", "2026-09-20");

    expect(cache.coverage()).toEqual({
      firstDate: "2026-08-25",
      lastDate: "2026-09-17",
      days: 15,
      cacheableThrough: "2026-09-17",
      spans: [
        { startDate: "2026-08-25", endDate: "2026-08-31" },
        { startDate: "2026-09-10", endDate: "2026-09-17" },
      ],
    });

    const reopened = new McpDayCache({
      directory,
      maxBytes: 1024 * 1024,
      refetchDays: 2,
      now: () => new Date("2026-09-20T12:00:00Z"),
    });
    await reopened.open();
    expect(reopened.coverage().days).toBe(0);
    await reopened.activate("key-a");
    expect(reopened.coverage()).toEqual(cache.coverage());
  });

  it("drops every cached day when the API key changes", async () => {
    const { cache, directory } = await createCache();
    const { client, fetcher } = createClient();
    await load(client, cache);

    await cache.activate("key-b");

    expect(await persistedDates(directory)).toEqual([]);
    expect(cache.persistedBytes).toBe(0);
    fetcher.mockClear();
    await load(client, cache);
    expect(requestedWindows(fetcher)).toEqual([["2026-09-01", "2026-09-20"]]);
  });

  it("keeps cached days when the same API key is activated again", async () => {
    const { cache, directory } = await createCache();
    const { client } = createClient();
    await load(client, cache);
    const before = await persistedDates(directory);

    await cache.activate("key-a");

    expect(await persistedDates(directory)).toEqual(before);
  });

  it("evicts the oldest days to stay within the size cap", async () => {
    const { cache: probe, directory: probeDirectory } = await createCache();
    await load(createClient().client, probe, "2026-09-01", "2026-09-01");
    const dayBytes = probe.persistedBytes;
    const { cache, directory } = await createCache({ maxBytes: dayBytes * 3 });

    await load(createClient().client, cache);

    expect(await persistedDates(probeDirectory)).toEqual(["2026-09-01"]);
    expect(await persistedDates(directory)).toEqual([
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
    ]);
    expect(cache.persistedBytes).toBeLessThanOrEqual(dayBytes * 3);
  });

  it("does not persist days from a window that stopped at a cap", async () => {
    const { cache, directory } = await createCache();
    const { client } = createClient({ maxRecords: 5 });

    const dataset = await client.fetchMcpDataset("2026-09-01", "2026-09-17", {
      runs: cache,
    });
    const dates = await readDates(dataset);
    dataset.release();

    expect(dates).toEqual(datesBetween("2026-09-13", "2026-09-17"));
    expect(dataset.notices).toEqual([
      expect.objectContaining({
        setting: "MAX_MCP_RECORDS",
        message: expect.stringContaining("No day in this range is complete"),
      }),
    ]);
    expect(await persistedDates(directory)).toEqual([]);
  });

  it("removes a result's working files once it is released", async () => {
    const { cache, directory } = await createCache();
    const { client } = createClient();

    const dataset = await client.fetchMcpDataset("2026-09-01", "2026-09-05", {
      runs: cache,
    });
    expect(await readdir(join(directory, "runs"))).toHaveLength(1);
    dataset.release();

    await vi.waitFor(async () =>
      expect(await readdir(join(directory, "runs"))).toEqual([]),
    );
  });

  it("deletes persisted days when cleared", async () => {
    const { cache, directory } = await createCache();
    await load(createClient().client, cache);

    await cache.clear();

    await expect(readdir(join(directory, "days"))).rejects.toThrow();
    expect(cache.persistedBytes).toBe(0);
  });
});
