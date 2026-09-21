import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseInitArgs,
  promptSecret,
  renderEnv,
  renderEnvWithApiKey,
  runInit,
  writeApiKeyEnv,
} from "./initialize-dashboard";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dashboard init", () => {
  it("runs the help path without prompting or writing configuration", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runInit(["--help"]);

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("Usage: npm run init -- [options]");
  });

  it("adds the API key without discarding existing configuration", () => {
    expect(
      renderEnvWithApiKey(
        "CURSOR_TEAM_NAME=Example Team\nPORT=5173\n",
        "key_new",
      ),
    ).toBe(
      "CURSOR_TEAM_NAME=Example Team\nPORT=5173\n\nCURSOR_API_KEY=key_new\n",
    );
  });

  it("replaces duplicate API key entries", () => {
    expect(
      renderEnvWithApiKey(
        "CURSOR_API_KEY=key_old\nPORT=5173\nCURSOR_API_KEY=key_duplicate\n",
        "key_new",
      ),
    ).toBe("CURSOR_API_KEY=key_new\nPORT=5173\n");
  });

  it("rejects values that cannot be safely stored in dotenv", () => {
    expect(() => renderEnvWithApiKey("", "key with spaces")).toThrow(
      "cannot be empty or contain whitespace",
    );
  });

  it("parses supported setup options", () => {
    expect(
      parseInitArgs([
        "--port=5199",
        "--server-port",
        "5000",
        "--team-name",
        "Platform Engineering",
        "--host",
        "localhost",
      ]),
    ).toEqual({
      port: 5199,
      serverPort: 5000,
      teamName: "Platform Engineering",
      bindHost: "localhost",
    });
  });

  it("rejects unsafe or invalid options", () => {
    expect(() => parseInitArgs(["--port", "70000"])).toThrow(
      "integer from 1 to 65535",
    );
    expect(() => parseInitArgs(["--api-key=secret"])).toThrow(
      "do not pass the API key as an argument",
    );
    expect(() => parseInitArgs(["--unknown"])).toThrow(
      "Unknown option: --unknown",
    );
    expect(() => parseInitArgs(["--bind-host", "0.0.0.0"])).toThrow(
      "ALLOW_UNAUTHENTICATED_NETWORK=1",
    );
    expect(() =>
      parseInitArgs(["--allow-unauthenticated-network=true"]),
    ).toThrow("does not accept a value");
  });

  it("accepts an explicitly acknowledged non-loopback bind", () => {
    expect(
      parseInitArgs([
        "--bind-host",
        "0.0.0.0",
        "--allow-unauthenticated-network",
      ]),
    ).toEqual({
      bindHost: "0.0.0.0",
      allowUnauthenticatedNetwork: true,
    });
  });

  it("fails safely when hidden input is unavailable", async () => {
    const input = { isTTY: false } as typeof process.stdin;
    const output = { isTTY: true } as typeof process.stdout;

    await expect(promptSecret("API key: ", input, output)).rejects.toThrow(
      "Set CURSOR_API_KEY in a protected environment file",
    );
  });

  it("fails safely when raw terminal mode cannot be enabled", async () => {
    const input = {
      isTTY: true,
      isRaw: false,
      setEncoding() {},
      setRawMode() {
        throw new Error("raw mode unavailable");
      },
    } as unknown as typeof process.stdin;
    const output = { isTTY: true } as typeof process.stdout;

    await expect(promptSecret("API key: ", input, output)).rejects.toThrow(
      "Set CURSOR_API_KEY in a protected environment file",
    );
  });

  it("quotes display values and updates existing settings", () => {
    expect(
      renderEnv("PORT=5173\nCURSOR_TEAM_NAME=Old\n", {
        PORT: "5199",
        CURSOR_TEAM_NAME: "Platform Engineering",
      }),
    ).toBe('PORT=5199\nCURSOR_TEAM_NAME="Platform Engineering"\n');
  });

  it("writes the file with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-dashboard-init-"));
    temporaryDirectories.push(directory);
    const envPath = join(directory, ".env");
    await writeFile(envPath, "PORT=5173\nSERVER_PORT=4173\n", { mode: 0o644 });

    await writeApiKeyEnv(envPath, "key_secure", {
      port: 5199,
      serverPort: 5000,
      bindHost: "0.0.0.0",
      allowUnauthenticatedNetwork: true,
    });

    const content = await readFile(envPath, "utf8");
    expect(content).toContain("PORT=5199\n");
    expect(content).toContain("SERVER_PORT=5000\n");
    expect(content).toContain("BIND_HOST=0.0.0.0\n");
    expect(content).toContain("ALLOW_UNAUTHENTICATED_NETWORK=1\n");
    expect(content).toContain("CURSOR_API_KEY=key_secure\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });
});
