import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  parseMcpRecord,
  type McpRecord,
} from "../../contracts/mcp-response.js";
import {
  addDays,
  countRecordsWithinBytes,
  createMemoryDataset,
  recordBytes,
  sortDayRecords,
  type DayPlan,
  type DayStats,
  type McpDataset,
  type McpDatasetInfo,
  type McpRun,
  type McpRunFactory,
} from "../cursor/mcp-collection.js";

const FORMAT = "mcp-day";
const VERSION = 1;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

interface DayHeader {
  format: typeof FORMAT;
  version: typeof VERSION;
  date: string;
  records: number;
  bytes: number;
  sha256: string;
}

export interface McpDayCacheOptions {
  directory: string;
  /** Cap on the total size of persisted day files. */
  maxBytes: number;
  /** Days before today that are always refetched instead of cached. */
  refetchDays: number;
  now?: () => Date;
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function countLines(body: Buffer): number {
  let lines = 0;
  for (const byte of body) if (byte === 0x0a) lines += 1;
  return lines;
}

/**
 * Parses and verifies a day file. Returns null when the header, size,
 * checksum, or line count does not match, so callers can discard the file.
 */
function verifyDayFile(
  content: Buffer,
  date: string,
): { header: DayHeader; body: Buffer } | null {
  const newline = content.indexOf(0x0a);
  if (newline < 0) return null;
  let header: unknown;
  try {
    header = JSON.parse(content.subarray(0, newline).toString("utf8"));
  } catch {
    return null;
  }
  const body = content.subarray(newline + 1);
  if (
    !header ||
    typeof header !== "object" ||
    !("format" in header) ||
    header.format !== FORMAT ||
    !("version" in header) ||
    header.version !== VERSION ||
    !("date" in header) ||
    header.date !== date ||
    !("records" in header) ||
    !isNonNegativeInteger(header.records) ||
    !("bytes" in header) ||
    !isNonNegativeInteger(header.bytes) ||
    !("sha256" in header) ||
    typeof header.sha256 !== "string" ||
    body.length !== header.bytes ||
    countLines(body) !== header.records ||
    sha256(body) !== header.sha256
  ) {
    return null;
  }
  return { header: header as DayHeader, body };
}

function serializeDay(date: string, records: readonly McpRecord[]): string {
  const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  const header: DayHeader = {
    format: FORMAT,
    version: VERSION,
    date,
    records: records.length,
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: sha256(body),
  };
  return `${JSON.stringify(header)}\n${body}`;
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Hard-links a file, copying it when the filesystem cannot link. */
async function linkOrCopy(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT", "EEXIST")) throw error;
    await copyFile(source, target);
  }
}

async function readDayRecords(
  path: string,
  date: string,
): Promise<McpRecord[]> {
  const verified = verifyDayFile(await readFile(path), date);
  if (!verified) {
    throw new Error("A cached MCP activity day failed verification.");
  }
  const records: McpRecord[] = [];
  for (const line of verified.body.toString("utf8").split("\n")) {
    if (!line) continue;
    const record = parseMcpRecord(JSON.parse(line));
    if (record.date !== date) {
      throw new Error("A cached MCP activity record has the wrong date.");
    }
    records.push(record);
  }
  return records;
}

/**
 * Persists MCP activity as one verified file per UTC day.
 *
 * Layout under `directory`:
 * - `manifest.json`: format version and a fingerprint of the active API key
 * - `days/<date>.ndjson`: persisted complete days, bounded by `maxBytes`
 * - `runs/<id>/`: per-result working files, removed when the result is
 *   released and on startup
 *
 * Results link the day files they use into their own run directory, so
 * eviction or invalidation never removes data from a result being served.
 */
export class McpDayCache implements McpRunFactory {
  private readonly directory: string;
  private readonly daysDirectory: string;
  private readonly runsDirectory: string;
  private readonly maxBytes: number;
  private readonly refetchDays: number;
  private readonly now: () => Date;
  private fingerprint = "";
  private generation = 0;
  private initialized = false;
  private readonly sizes = new Map<string, number>();
  private totalBytes = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ directory, maxBytes, refetchDays, now }: McpDayCacheOptions) {
    this.directory = directory;
    this.daysDirectory = join(directory, "days");
    this.runsDirectory = join(directory, "runs");
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.refetchDays = Math.max(0, Math.floor(refetchDays));
    this.now = now ?? (() => new Date());
  }

  get persistedBytes(): number {
    return this.totalBytes;
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!this.initialized) {
      // Run directories belong to results of a previous process.
      await rm(this.runsDirectory, { recursive: true, force: true });
      this.initialized = true;
    }
    await mkdir(this.runsDirectory, { recursive: true, mode: 0o700 });
  }

  /** Creates the cache directory and removes leftovers from earlier processes. */
  open(): Promise<void> {
    return this.exclusive(() => this.prepare());
  }

  /**
   * Binds the cache to an API key. Persisted days written under a different
   * key are deleted, so a key change always starts from an empty cache. If
   * activation fails, persistence stays disabled until the next activation.
   */
  activate(apiKey: string): Promise<void> {
    const fingerprint = sha256(`mcp-day-cache\0${apiKey}`);
    return this.exclusive(async () => {
      this.fingerprint = "";
      this.generation += 1;
      await this.prepare();
      const manifestPath = join(this.directory, "manifest.json");
      let manifest: unknown;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch {
        manifest = undefined;
      }
      const matches =
        Boolean(manifest) &&
        typeof manifest === "object" &&
        manifest !== null &&
        "version" in manifest &&
        manifest.version === VERSION &&
        "key" in manifest &&
        manifest.key === fingerprint;
      if (!matches) {
        await rm(this.daysDirectory, { recursive: true, force: true });
        await writeFileAtomic(
          manifestPath,
          `${JSON.stringify({ version: VERSION, key: fingerprint })}\n`,
        );
      }
      await mkdir(this.daysDirectory, { recursive: true, mode: 0o700 });
      await this.scan();
      this.fingerprint = fingerprint;
      await this.enforceCap();
    });
  }

  /** Deletes every persisted day and detaches the cache from its key. */
  clear(): Promise<void> {
    return this.exclusive(async () => {
      this.generation += 1;
      this.fingerprint = "";
      await rm(this.daysDirectory, { recursive: true, force: true });
      await rm(join(this.directory, "manifest.json"), { force: true });
      this.sizes.clear();
      this.totalBytes = 0;
    });
  }

  /** Days in the refetch window (today and the previous N days) are never cached. */
  isCacheable(date: string): boolean {
    const today = this.now().toISOString().slice(0, 10);
    return date <= addDays(today, -(this.refetchDays + 1));
  }

  private async scan(): Promise<void> {
    this.sizes.clear();
    this.totalBytes = 0;
    for (const name of await readdir(this.daysDirectory)) {
      const date = DAY_FILE.exec(name)?.[1];
      const path = join(this.daysDirectory, name);
      if (!date) {
        await rm(path, { force: true, recursive: true });
        continue;
      }
      const { size } = await stat(path);
      this.sizes.set(date, size);
      this.totalBytes += size;
    }
  }

  private async enforceCap(): Promise<void> {
    if (this.totalBytes <= this.maxBytes) return;
    const dates = [...this.sizes.keys()].sort();
    for (const date of dates) {
      if (this.totalBytes <= this.maxBytes) break;
      await this.forget(date);
    }
  }

  private async forget(date: string): Promise<void> {
    await rm(join(this.daysDirectory, `${date}.ndjson`), { force: true });
    this.totalBytes -= this.sizes.get(date) ?? 0;
    this.sizes.delete(date);
  }

  dayPath(date: string): string {
    return join(this.daysDirectory, `${date}.ndjson`);
  }

  async beginRun(): Promise<McpRun> {
    const runDirectory = join(this.runsDirectory, randomUUID());
    await mkdir(join(runDirectory, "staging"), {
      recursive: true,
      mode: 0o700,
    });
    return new DiskMcpRun(this, runDirectory, this.generation);
  }

  /** @internal Whether a run started at `generation` may read or write days. */
  usable(generation: number): boolean {
    return Boolean(this.fingerprint) && generation === this.generation;
  }

  /** @internal Removes a persisted day that failed verification. */
  discardCorrupt(date: string, generation: number): Promise<void> {
    return this.exclusive(async () => {
      if (generation === this.generation) await this.forget(date);
    });
  }

  /** @internal Persists a sealed run file as the cached copy of `date`. */
  promote(date: string, path: string, generation: number): Promise<void> {
    return this.exclusive(async () => {
      if (!this.usable(generation) || !this.isCacheable(date)) return;
      const target = this.dayPath(date);
      const temporaryPath = `${target}.${randomUUID()}.tmp`;
      try {
        await linkOrCopy(path, temporaryPath);
        await rename(temporaryPath, target);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      const { size } = await stat(target);
      this.totalBytes += size - (this.sizes.get(date) ?? 0);
      this.sizes.set(date, size);
      await this.enforceCap();
    });
  }
}

class DiskMcpRun implements McpRun {
  private readonly stats = new Map<string, DayStats>();
  private readonly stagedDates = new Set<string>();

  constructor(
    private readonly cache: McpDayCache,
    private readonly directory: string,
    private readonly generation: number,
  ) {}

  private runPath(date: string): string {
    return join(this.directory, `${date}.ndjson`);
  }

  private stagingPath(date: string): string {
    return join(this.directory, "staging", `${date}.ndjson`);
  }

  async adoptCachedDays(
    dates: readonly string[],
  ): Promise<Map<string, DayStats>> {
    const adopted = new Map<string, DayStats>();
    if (!this.cache.usable(this.generation)) return adopted;
    for (const date of dates) {
      if (!this.cache.isCacheable(date)) continue;
      const target = this.runPath(date);
      try {
        await linkOrCopy(this.cache.dayPath(date), target);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      const verified = verifyDayFile(await readFile(target), date);
      if (!verified) {
        await rm(target, { force: true });
        await this.cache.discardCorrupt(date, this.generation);
        continue;
      }
      const stats = {
        records: verified.header.records,
        bytes: verified.header.bytes,
      };
      this.stats.set(date, stats);
      adopted.set(date, stats);
    }
    return adopted;
  }

  async write(records: readonly McpRecord[]): Promise<void> {
    const lines = new Map<string, string[]>();
    for (const record of records) {
      const day = lines.get(record.date);
      const line = `${JSON.stringify(record)}\n`;
      if (day) day.push(line);
      else lines.set(record.date, [line]);
    }
    for (const [date, dayLines] of lines) {
      this.stagedDates.add(date);
      await appendFile(this.stagingPath(date), dayLines.join(""), {
        mode: 0o600,
      });
    }
  }

  async sealWindow(
    dates: readonly string[],
    complete: boolean,
  ): Promise<Map<string, DayStats>> {
    const sealed = new Map<string, DayStats>();
    for (const date of dates) {
      let records: McpRecord[] = [];
      if (this.stagedDates.has(date)) {
        const staged = await readFile(this.stagingPath(date), "utf8");
        records = staged
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as McpRecord);
        await rm(this.stagingPath(date), { force: true });
        this.stagedDates.delete(date);
      }
      sortDayRecords(records);
      const path = this.runPath(date);
      await writeFileAtomic(path, serializeDay(date, records));
      const stats = {
        records: records.length,
        bytes: records.reduce(
          (total, record) => total + recordBytes(record),
          0,
        ),
      };
      this.stats.set(date, stats);
      sealed.set(date, stats);
      if (complete) await this.cache.promote(date, path, this.generation);
    }
    return sealed;
  }

  async countWithinBytes(
    date: string,
    maxRecords: number,
    maxBytes: number,
  ): Promise<number> {
    return countRecordsWithinBytes(
      await readDayRecords(this.runPath(date), date),
      maxRecords,
      maxBytes,
    );
  }

  createDataset(days: DayPlan[], info: McpDatasetInfo): McpDataset {
    const included = days
      .map((day) => ({
        ...day,
        count: Math.min(
          this.stats.get(day.date)?.records ?? 0,
          day.limit ?? Number.MAX_SAFE_INTEGER,
        ),
      }))
      .filter((day) => day.count > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (included.length === 0) {
      void this.discard();
      return createMemoryDataset([], info);
    }
    const directory = this.directory;
    const paths = new Map(
      included.map((day) => [day.date, this.runPath(day.date)]),
    );
    let references = 1;
    return {
      ...info,
      recordCount: included.reduce((total, day) => total + day.count, 0),
      async *readDays(order) {
        const sequence =
          order === "ascending" ? included : [...included].reverse();
        for (const day of sequence) {
          const records = await readDayRecords(
            paths.get(day.date) ?? "",
            day.date,
          );
          yield {
            date: day.date,
            records:
              day.limit === undefined ? records : records.slice(0, day.limit),
          };
        }
      },
      acquire() {
        references += 1;
      },
      release() {
        references -= 1;
        if (references === 0) {
          void rm(directory, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      },
    };
  }

  async discard(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}
