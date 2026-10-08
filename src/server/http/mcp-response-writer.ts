import {
  McpSummaryAccumulator,
  type McpRecord,
  type McpResponse,
  type McpResponseNotice,
} from "../../contracts/mcp-response.js";
import type { TeamMetadata } from "../cursor/cursor-api.js";
import {
  addDays,
  formatCount,
  type McpDataset,
} from "../cursor/mcp-collection.js";

const BATCH_SIZE = 5_000;

export interface ResponseContext {
  dataset: McpDataset;
  metadata?: TeamMetadata;
  teamName: string;
  maxEnrichedGroupAssignments: number;
  /** Notices about the server state, such as a directory still loading. */
  notices?: McpResponseNotice[];
}

/** Records on `date` at index `fromIndex` or later, and all later days, get groups. */
interface EnrichmentCutoff {
  date: string;
  fromIndex: number;
}

interface EnrichmentPlan {
  cutoff?: EnrichmentCutoff;
  notice?: McpResponseNotice;
}

export type ChunkWriter = (chunk: string) => Promise<void>;

function enrichmentNotice(
  limit: number,
  cutoffDate: string,
  endDate: string,
): McpResponseNotice {
  const completeFrom = addDays(cutoffDate, 1);
  const complete = completeFrom <= endDate;
  return {
    code: "LIMIT_REACHED",
    message: `Directory groups are attached to recent activity only: the ${formatCount(limit)}-assignment limit (MAX_ENRICHED_GROUP_ASSIGNMENTS) was reached. ${
      complete
        ? `Activity from ${completeFrom} onward has complete group data; activity on or before ${cutoffDate} is missing some groups.`
        : "No day in this range has complete group data."
    } Raise MAX_ENRICHED_GROUP_ASSIGNMENTS or choose ${
      complete
        ? `a range starting on or after ${completeFrom}`
        : "a shorter date range"
    } for complete group data.`,
    setting: "MAX_ENRICHED_GROUP_ASSIGNMENTS",
    limit,
    ...(complete ? { completeFrom } : {}),
  };
}

/**
 * Finds where group assignments must stop so the newest records keep their
 * groups. Skips the scan when the cap cannot be reached.
 */
async function planEnrichment(
  dataset: McpDataset,
  metadata: TeamMetadata | undefined,
  limit: number,
): Promise<EnrichmentPlan> {
  if (!metadata || metadata.users.size === 0) return {};
  let maxGroups = 0;
  for (const user of metadata.users.values()) {
    maxGroups = Math.max(maxGroups, user.directoryGroups.length);
  }
  if (maxGroups * dataset.recordCount <= limit) return {};
  let assignments = 0;
  for await (const day of dataset.readDays("descending")) {
    for (let index = day.records.length - 1; index >= 0; index -= 1) {
      const record = day.records[index];
      const groups = record
        ? (metadata.users.get(record.email)?.directoryGroups.length ?? 0)
        : 0;
      if (assignments + groups > limit) {
        return {
          cutoff: { date: day.date, fromIndex: index + 1 },
          notice: enrichmentNotice(limit, day.date, dataset.range.endDate),
        };
      }
      assignments += groups;
    }
  }
  return {};
}

function enrichRecord(
  record: McpRecord,
  metadata: TeamMetadata | undefined,
  includeGroups: boolean,
): McpRecord {
  const user = metadata?.users.get(record.email);
  if (!user) return record;
  return {
    ...record,
    displayName: user.name,
    role: user.role,
    ...(includeGroups ? { directoryGroups: [...user.directoryGroups] } : {}),
  };
}

function responseTeam(
  context: ResponseContext,
): NonNullable<McpResponse["team"]> {
  const id = context.dataset.team?.id ?? "";
  return {
    id,
    name:
      context.teamName ||
      context.dataset.team?.name ||
      (id ? `Team ${id}` : "Team"),
    memberCount: context.metadata?.memberCount ?? 0,
    groupCount: context.metadata?.groupNames.length ?? 0,
  };
}

/**
 * Reads the dataset one day at a time in ascending date order and yields
 * enriched record batches, then returns the summary and every notice.
 */
async function* recordBatches(
  context: ResponseContext,
): AsyncGenerator<
  McpRecord[],
  { summary: McpResponse["summary"]; notices: McpResponseNotice[] }
> {
  const { dataset, metadata } = context;
  const plan = await planEnrichment(
    dataset,
    metadata,
    Math.max(1, Math.floor(context.maxEnrichedGroupAssignments)),
  );
  const summary = new McpSummaryAccumulator();
  let batch: McpRecord[] = [];
  for await (const day of dataset.readDays("ascending")) {
    for (let index = 0; index < day.records.length; index += 1) {
      const record = day.records[index];
      if (!record) continue;
      const includeGroups =
        !plan.cutoff ||
        day.date > plan.cutoff.date ||
        (day.date === plan.cutoff.date && index >= plan.cutoff.fromIndex);
      const enriched = enrichRecord(record, metadata, includeGroups);
      summary.add(enriched);
      batch.push(enriched);
      if (batch.length >= BATCH_SIZE) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length > 0) yield batch;
  return {
    summary: summary.result(),
    notices: [
      ...dataset.notices,
      ...(metadata?.notices ?? []),
      ...(plan.notice ? [plan.notice] : []),
      ...(context.notices ?? []),
    ],
  };
}

function responseHeader(context: ResponseContext) {
  return {
    range: context.dataset.range,
    generatedAt: context.dataset.generatedAt,
    source: "live" as const,
    team: responseTeam(context),
  };
}

async function drain(
  context: ResponseContext,
  onBatch: (batch: McpRecord[]) => Promise<void>,
) {
  const batches = recordBatches(context);
  for (;;) {
    const next = await batches.next();
    if (next.done) return next.value;
    await onBatch(next.value);
  }
}

/**
 * Writes a complete JSON analytics response incrementally, so the result is
 * never materialized as one string or one array.
 */
export async function writeJsonResponse(
  write: ChunkWriter,
  context: ResponseContext,
): Promise<void> {
  const header = JSON.stringify(responseHeader(context));
  await write(`${header.slice(0, -1)},"records":[`);
  let first = true;
  const footer = await drain(context, async (batch) => {
    const body = batch.map((record) => JSON.stringify(record)).join(",");
    await write(first ? body : `,${body}`);
    first = false;
  });
  const notices =
    footer.notices.length > 0
      ? `,"notices":${JSON.stringify(footer.notices)}`
      : "";
  await write(`],"summary":${JSON.stringify(footer.summary)}${notices}}`);
}

/**
 * Writes NDJSON `records` events in batches followed by one `data` event
 * that carries everything except the records.
 */
export async function writeNdjsonResponse(
  write: ChunkWriter,
  context: ResponseContext,
): Promise<number> {
  let recordCount = 0;
  const footer = await drain(context, async (batch) => {
    recordCount += batch.length;
    await write(`${JSON.stringify({ type: "records", records: batch })}\n`);
  });
  await write(
    `${JSON.stringify({
      type: "data",
      data: {
        ...responseHeader(context),
        summary: footer.summary,
        ...(footer.notices.length > 0 ? { notices: footer.notices } : {}),
      },
    })}\n`,
  );
  return recordCount;
}
