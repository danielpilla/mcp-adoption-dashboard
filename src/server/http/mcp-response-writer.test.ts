import { describe, expect, it } from "vitest";
import type { McpRecord, McpResponse } from "../../contracts/mcp-response";
import type { TeamMetadata } from "../cursor/cursor-api";
import { createMemoryDataset } from "../cursor/mcp-collection";
import {
  writeJsonResponse,
  writeNdjsonResponse,
  type ResponseContext,
} from "./mcp-response-writer";

function record(date: string, user: string, usage = 1): McpRecord {
  return {
    date,
    userId: user,
    email: `${user}@example.com`,
    displayName: user,
    server: "server-1",
    tool: "tool-1",
    usage,
  };
}

const metadata: TeamMetadata = {
  users: new Map([
    [
      "user-1@example.com",
      {
        name: "User One",
        role: "member",
        directoryGroups: ["group-1", "group-2"],
      },
    ],
  ]),
  memberCount: 1,
  groupNames: ["group-1", "group-2"],
};

function context(
  records: McpRecord[],
  overrides: Partial<ResponseContext> = {},
): ResponseContext {
  const days = new Map<string, McpRecord[]>();
  for (const item of records) {
    days.set(item.date, [...(days.get(item.date) ?? []), item]);
  }
  return {
    dataset: createMemoryDataset(
      [...days].map(([date, dayRecords]) => ({ date, records: dayRecords })),
      {
        range: { startDate: "2026-09-01", endDate: "2026-09-03" },
        generatedAt: "2026-09-04T00:00:00.000Z",
        team: { id: "team-1", name: "" },
        notices: [],
      },
    ),
    metadata,
    teamName: "",
    maxEnrichedGroupAssignments: 1_000,
    ...overrides,
  };
}

async function collect(
  writer: (write: (chunk: string) => Promise<void>) => Promise<unknown>,
): Promise<string> {
  let output = "";
  await writer(async (chunk) => {
    output += chunk;
  });
  return output;
}

describe("MCP response writer", () => {
  it("streams a complete JSON response with enriched records", async () => {
    const body = JSON.parse(
      await collect((write) =>
        writeJsonResponse(
          write,
          context([
            record("2026-09-01", "user-1", 2),
            record("2026-09-02", "user-2", 3),
          ]),
        ),
      ),
    ) as McpResponse;

    expect(body.records).toEqual([
      {
        ...record("2026-09-01", "user-1", 2),
        displayName: "User One",
        role: "member",
        directoryGroups: ["group-1", "group-2"],
      },
      record("2026-09-02", "user-2", 3),
    ]);
    expect(body.summary.totalUsage).toBe(5);
    expect(body.team).toEqual({
      id: "team-1",
      name: "Team team-1",
      memberCount: 1,
      groupCount: 2,
    });
    expect(body).not.toHaveProperty("notices");
  });

  it("writes an empty JSON record list", async () => {
    const body = JSON.parse(
      await collect((write) => writeJsonResponse(write, context([]))),
    ) as McpResponse;

    expect(body.records).toEqual([]);
    expect(body.summary.totalUsage).toBe(0);
  });

  it("emits NDJSON record batches before a data event without records", async () => {
    const records = Array.from({ length: 5_001 }, (_, index) =>
      record("2026-09-02", `user-${index + 2}`),
    );
    const events = (
      await collect((write) => writeNdjsonResponse(write, context(records)))
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            records?: unknown[];
            data?: McpResponse;
          },
      );

    expect(events.map((event) => [event.type, event.records?.length])).toEqual([
      ["records", 5_000],
      ["records", 1],
      ["data", undefined],
    ]);
    expect(events[2]?.data).not.toHaveProperty("records");
    expect(events[2]?.data?.summary.totalUsage).toBe(5_001);
  });

  it("keeps groups on the newest records when the assignment cap is reached", async () => {
    const body = JSON.parse(
      await collect((write) =>
        writeJsonResponse(
          write,
          context(
            [
              record("2026-09-01", "user-1"),
              record("2026-09-02", "user-1"),
              record("2026-09-03", "user-1"),
            ],
            { maxEnrichedGroupAssignments: 4 },
          ),
        ),
      ),
    ) as McpResponse;

    expect(body.records.map((item) => item.directoryGroups)).toEqual([
      undefined,
      ["group-1", "group-2"],
      ["group-1", "group-2"],
    ]);
    expect(body.records[0]?.displayName).toBe("User One");
    expect(body.notices).toEqual([
      expect.objectContaining({
        code: "LIMIT_REACHED",
        setting: "MAX_ENRICHED_GROUP_ASSIGNMENTS",
        limit: 4,
        completeFrom: "2026-09-02",
      }),
    ]);
  });

  it("orders dataset, directory, enrichment, and server notices", async () => {
    const notice = (setting: string) => ({
      code: "LIMIT_REACHED" as const,
      message: setting,
      setting,
    });
    const base = context([record("2026-09-03", "user-1")], {
      metadata: { ...metadata, notices: [notice("MAX_DIRECTORY_GROUPS")] },
      maxEnrichedGroupAssignments: 1,
      notices: [{ code: "DIRECTORY_LOADING", message: "loading" }],
    });
    base.dataset.notices.push(notice("MAX_MCP_RECORDS"));

    const body = JSON.parse(
      await collect((write) => writeJsonResponse(write, base)),
    ) as McpResponse;

    expect(body.notices?.map((item) => item.setting ?? item.code)).toEqual([
      "MAX_MCP_RECORDS",
      "MAX_DIRECTORY_GROUPS",
      "MAX_ENRICHED_GROUP_ASSIGNMENTS",
      "DIRECTORY_LOADING",
    ]);
  });
});
