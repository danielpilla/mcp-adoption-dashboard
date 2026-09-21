import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CursorApiClient,
  CursorApiError,
  type TeamMetadata,
} from "../cursor/cursor-api";
import { validateSavedClient, writeSetupEnv } from "./api-key-setup";

const metadata: TeamMetadata = {
  users: new Map(),
  memberCount: 1,
  groupNames: [],
};

describe("saved API key validation", () => {
  it("accepts a key that can load team metadata", async () => {
    const client = new CursorApiClient("valid");
    vi.spyOn(client, "fetchTeamMetadata").mockResolvedValue(metadata);

    await expect(validateSavedClient(client)).resolves.toEqual({
      client,
      metadata,
      status: "valid",
    });
  });

  it.each([401, 403])(
    "returns to setup mode for a rejected key (%s)",
    async (status) => {
      const client = new CursorApiClient("invalid");
      vi.spyOn(client, "fetchTeamMetadata").mockRejectedValue(
        new CursorApiError("rejected", status),
      );

      await expect(validateSavedClient(client)).resolves.toEqual({
        status: "invalid",
      });
    },
  );

  it("keeps the key during a transient Cursor outage", async () => {
    const client = new CursorApiClient("temporarily-unavailable");
    vi.spyOn(client, "fetchTeamMetadata").mockRejectedValue(
      new CursorApiError("unavailable", 503),
    );

    await expect(validateSavedClient(client)).resolves.toEqual({
      client,
      status: "deferred",
    });
  });
});

describe("saved API key persistence", () => {
  it("atomically replaces the env file with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-dashboard-setup-"));
    const envPath = join(directory, ".env");
    try {
      await writeFile(envPath, "PORT=4173\nCURSOR_API_KEY=old\n", {
        mode: 0o644,
      });

      await writeSetupEnv(envPath, "key_secure");

      expect(await readFile(envPath, "utf8")).toBe(
        "PORT=4173\nCURSOR_API_KEY=key_secure\n",
      );
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual([".env"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
