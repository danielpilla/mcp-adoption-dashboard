import { open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { CursorApiError, type CursorApiClient } from "../cursor/cursor-api.js";

export type SavedKeyValidation = {
  client?: CursorApiClient;
  metadata?: Awaited<ReturnType<CursorApiClient["fetchTeamMetadata"]>>;
  status: "valid" | "invalid" | "deferred";
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function validateSavedClient(
  client: CursorApiClient,
  signal?: AbortSignal,
): Promise<SavedKeyValidation> {
  try {
    const metadata = await client.fetchTeamMetadata(signal);
    return { client, metadata, status: "valid" };
  } catch (error) {
    if (
      error instanceof CursorApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      return { status: "invalid" };
    }
    return { client, status: "deferred" };
  }
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderEnv(
  existingContent: string,
  updates: Record<string, string>,
): string {
  const entries = Object.entries(updates);
  const updateKeys = new Set(entries.map(([key]) => key));
  const writtenKeys = new Set<string>();
  const lines = existingContent
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const key = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1];
      if (!key || !updateKeys.has(key)) return true;
      if (writtenKeys.has(key)) return false;
      writtenKeys.add(key);
      return true;
    })
    .map((line) => {
      const key = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1];
      if (!key || !updateKeys.has(key)) return line;
      const value = updates[key];
      return value === undefined ? line : `${key}=${formatEnvValue(value)}`;
    });

  while (lines.at(-1) === "") lines.pop();
  const missingEntries = entries.filter(([key]) => !writtenKeys.has(key));
  if (missingEntries.length > 0 && lines.length > 0) lines.push("");
  for (const [key, value] of missingEntries) {
    lines.push(`${key}=${formatEnvValue(value)}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderEnvWithApiKey(
  existingContent: string,
  apiKey: string,
): string {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey || /[\s\0]/.test(normalizedKey)) {
    throw new Error("The API key cannot be empty or contain whitespace.");
  }
  return renderEnv(existingContent, { CURSOR_API_KEY: normalizedKey });
}

export async function writeSetupEnv(
  path: string,
  apiKey: string,
  updates: Record<string, string> = {},
): Promise<void> {
  let existingContent = "";
  try {
    existingContent = await readFile(path, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  const nextContent = renderEnv(
    renderEnvWithApiKey(existingContent, apiKey),
    updates,
  );
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(nextContent, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
