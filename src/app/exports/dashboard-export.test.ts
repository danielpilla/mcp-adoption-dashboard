import { describe, expect, it } from "vitest";
import {
  serializeEmailsTsv,
  serializePivotCsv,
  serializeRecordsCsv,
  serializeUserMcpTsv,
} from "./dashboard-export";
import {
  buildPivot,
  pivotCellKey,
  pivotTupleKey,
  type PivotResult,
} from "../pivot/pivot-model";
import type { UserMcpConnection } from "../reporting/user-mcp-connections";
import type { McpRecord } from "../../contracts/mcp-response";

function connection(
  index: number,
  overrides: Partial<UserMcpConnection> = {},
): UserMcpConnection {
  return {
    userId: `user_${index}`,
    email: `user${index}@example.com`,
    displayName: `User ${index}`,
    role: "member",
    directoryGroups: ["Developers"],
    server: index % 2 === 0 ? "slack" : "atlassian",
    firstObserved: "2026-07-01",
    lastObserved: "2026-09-18",
    activeDays: 4,
    totalCalls: index + 1,
    tools: ["search", "read"],
    ...overrides,
  };
}

describe("user MCP TSV export", () => {
  it("uses stable analytics columns and escapes spreadsheet content", () => {
    const tsv = serializeUserMcpTsv([
      connection(1, {
        displayName: ' \t=HYPERLINK("bad")',
        directoryGroups: ["Platform\tAdmin"],
      }),
    ]);
    const [headers, row] = tsv.split("\n");

    expect(headers.split("\t")).toEqual([
      "display_name",
      "email",
      "role",
      "directory_groups",
      "mcp_server",
      "first_observed",
      "last_observed",
      "active_days",
      "total_calls",
      "distinct_tools",
      "tools",
    ]);
    expect(row).toContain(`"' \t=HYPERLINK(""bad"")"`);
    expect(row).toContain('"Platform\tAdmin"');
  });

  it("serializes the complete result beyond one visible UI page", () => {
    const rows = Array.from({ length: 125 }, (_, index) =>
      connection(index + 1),
    );
    const tsv = serializeUserMcpTsv(rows);

    expect(tsv.split("\n")).toHaveLength(126);
    expect(tsv).toContain("user125@example.com");
  });
});

describe("email TSV export", () => {
  it("writes a stable header with sorted unique email rows", () => {
    expect(
      serializeEmailsTsv([
        "Bob@Example.com",
        "alice@example.com",
        "bob@example.com",
        " ",
      ]),
    ).toBe("email\nalice@example.com\nbob@example.com");
  });
});

describe("CSV exports", () => {
  it("neutralizes spreadsheet formulas in raw activity fields", () => {
    const record: McpRecord = {
      date: "2026-09-18",
      userId: "user_1",
      email: "alex@example.com",
      displayName: '  =HYPERLINK("bad")',
      server: " \t+unsafe",
      tool: "search",
      usage: 5,
    };

    const csv = serializeRecordsCsv([record]);
    expect(csv).toContain(`"'  =HYPERLINK(""bad"")"`);
    expect(csv).toContain("' \t+unsafe");
  });

  it("includes pivot row totals and a grand-total row", () => {
    const slack = pivotTupleKey(["slack"]);
    const figma = pivotTupleKey(["figma"]);
    const engineering = pivotTupleKey(["Engineering"]);
    const pivot: PivotResult = {
      rowKeys: [slack, figma],
      rowHeaders: ["MCP server"],
      rowLabels: new Map([
        [slack, "slack"],
        [figma, "figma"],
      ]),
      rowValues: new Map([
        [slack, ["slack"]],
        [figma, ["figma"]],
      ]),
      columnKeys: [engineering],
      columnLabels: new Map([[engineering, "Engineering"]]),
      columnValues: new Map([[engineering, ["Engineering"]]]),
      columnTotals: new Map([[engineering, 10]]),
      values: new Map([
        [pivotCellKey(slack, engineering), 7],
        [pivotCellKey(figma, engineering), 3],
      ]),
      rowTotals: new Map([
        [slack, 7],
        [figma, 3],
      ]),
      grandTotal: 10,
      rowTree: [],
    };

    expect(serializePivotCsv(pivot)).toBe(
      "MCP server,Engineering,Total\nslack,7,7\nfigma,3,3\nGrand total,10,10",
    );
  });

  it("uses source-derived pivot totals instead of summing overlapping rows", () => {
    const engineering = pivotTupleKey(["Engineering"]);
    const pilot = pivotTupleKey(["Pilot"]);
    const search = pivotTupleKey(["search"]);
    const pivot: PivotResult = {
      rowKeys: [engineering, pilot],
      rowHeaders: ["Group"],
      rowLabels: new Map([
        [engineering, "Engineering"],
        [pilot, "Pilot"],
      ]),
      rowValues: new Map([
        [engineering, ["Engineering"]],
        [pilot, ["Pilot"]],
      ]),
      columnKeys: [search],
      columnLabels: new Map([[search, "search"]]),
      columnValues: new Map([[search, ["search"]]]),
      columnTotals: new Map([[search, 1]]),
      values: new Map([
        [pivotCellKey(engineering, search), 1],
        [pivotCellKey(pilot, search), 1],
      ]),
      rowTotals: new Map([
        [engineering, 1],
        [pilot, 1],
      ]),
      grandTotal: 1,
      rowTree: [],
    };

    expect(serializePivotCsv(pivot)).toContain("Grand total,1,1");
  });

  it("exports readable labels instead of encoded pivot keys", () => {
    const pivot = buildPivot(
      [
        {
          date: "2026-09-18",
          userId: "user_1",
          email: "alex@example.com",
          displayName: "Alex",
          server: "a › b",
          tool: "c",
          usage: 5,
        },
      ],
      [],
      ["server", "tool"],
      "usage",
    );

    const csv = serializePivotCsv(pivot);
    expect(csv).toBe('All,"""a › b"" › c",Total\nAll,5,5\nGrand total,5,5');
  });
});
