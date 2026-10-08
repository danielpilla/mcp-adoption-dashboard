import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseStartupRange,
  type StartupRange,
} from "../../contracts/startup-range.js";

const VERSION = 1;

/** Reads and writes the remembered startup range. */
export interface StartupRangeStorage {
  read(): Promise<StartupRange | null>;
  write(range: StartupRange): Promise<void>;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Persists the startup range as a small JSON file, written atomically with
 * owner-only permissions. A missing or invalid file reads as no preference.
 */
export class StartupRangeFile implements StartupRangeStorage {
  private cached: StartupRange | null | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<StartupRange | null> {
    if (this.cached !== undefined) return this.cached;
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        this.cached = null;
        return null;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = undefined;
    }
    const range =
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      parsed.version === VERSION &&
      "range" in parsed
        ? parseStartupRange(parsed.range)
        : null;
    this.cached = range;
    return range;
  }

  write(range: StartupRange): Promise<void> {
    const action = async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify({ version: VERSION, range })}\n`,
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporaryPath, this.path);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      this.cached = range;
    };
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
