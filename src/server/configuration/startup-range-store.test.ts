import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StartupRangeFile } from "./startup-range-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempPath(name = "startup-range.json") {
  const directory = await mkdtemp(join(tmpdir(), "startup-range-store-"));
  directories.push(directory);
  return join(directory, name);
}

describe("startup range file", () => {
  it("reads a missing file as no preference", async () => {
    expect(await new StartupRangeFile(await tempPath()).read()).toBeNull();
  });

  it("writes atomically with owner-only permissions and reads it back", async () => {
    const path = await tempPath(join("nested", "startup-range.json"));
    const store = new StartupRangeFile(path);

    await store.write({ kind: "preset", days: 180 });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      range: { kind: "preset", days: 180 },
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await new StartupRangeFile(path).read()).toEqual({
      kind: "preset",
      days: 180,
    });
  });

  it("keeps the last of concurrent writes", async () => {
    const path = await tempPath();
    const store = new StartupRangeFile(path);

    await Promise.all([
      store.write({ kind: "preset", days: 7 }),
      store.write({
        kind: "custom",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      }),
    ]);

    expect(await new StartupRangeFile(path).read()).toEqual({
      kind: "custom",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    expect(await store.read()).toEqual({
      kind: "custom",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2, range: { kind: "preset", days: 30 } }),
    JSON.stringify({ version: 1, range: { kind: "preset", days: 999 } }),
    JSON.stringify({ kind: "preset", days: 30 }),
  ])("ignores the invalid file %s", async (content) => {
    const path = await tempPath();
    await writeFile(path, content);

    expect(await new StartupRangeFile(path).read()).toBeNull();
  });
});
