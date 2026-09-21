import { describe, expect, it } from "vitest";
import { summarizeMcpRecords, type McpRecord } from "../contracts/mcp-response";
import {
  continuousDailySeries,
  dailySeries,
  toolUsage,
  userUsage,
} from "./analytics/activity-metrics";
import {
  buildPivot,
  dimensionValue,
  pivotCellKey,
  pivotTupleKey,
} from "./pivot/pivot-model";
import { temporalValue } from "./scope/filter-model";
import { buildUserMcpConnections } from "./reporting/user-mcp-connections";

const records: McpRecord[] = [
  {
    date: "2026-09-01",
    userId: "1",
    email: "alex@example.com",
    displayName: "Alex",
    server: "github",
    tool: "search",
    usage: 10,
    directoryGroups: ["Engineering", "Pilot"],
  },
  {
    date: "2026-09-02",
    userId: "1",
    email: "alex@example.com",
    displayName: "Alex",
    server: "github",
    tool: "issues",
    usage: 4,
    directoryGroups: ["Engineering", "Pilot"],
  },
  {
    date: "2026-09-02",
    userId: "2",
    email: "sam@example.com",
    displayName: "Sam",
    server: "slack",
    tool: "search",
    usage: 7,
    directoryGroups: ["Product"],
  },
];

describe("dashboard data utilities", () => {
  it("preserves calendar gaps in daily series", () => {
    const sparse = [
      records[0],
      { ...records[0], date: "2026-09-03", usage: 4 },
    ];
    expect(
      continuousDailySeries(sparse, "usage", "2026-09-01", "2026-09-03"),
    ).toEqual([
      ["2026-09-01", 10],
      ["2026-09-02", 0],
      ["2026-09-03", 4],
    ]);
  });

  it("keeps pivot user labels tied to the source email", () => {
    const label = dimensionValue(records[0], "user");
    expect(label).toBe("Alex · alex@example.com");
    expect(
      records.find((record) => dimensionValue(record, "user") === label)?.email,
    ).toBe("alex@example.com");
  });

  it("counts server and tool pairs without delimiter collisions", () => {
    const ambiguousNames = [
      { ...records[0], server: "a\0b", tool: "c" },
      { ...records[0], server: "a", tool: "b\0c" },
    ];

    expect(summarizeMcpRecords(ambiguousNames).uniqueTools).toBe(2);
    expect(toolUsage(ambiguousNames)).toHaveLength(2);
    expect(userUsage(ambiguousNames)[0].tools).toBe(2);
  });

  it("builds usage pivots", () => {
    const pivot = buildPivot(records, ["server"], ["tool"], "usage");
    const github = pivotTupleKey(["github"]);
    expect(
      pivot.values.get(pivotCellKey(github, pivotTupleKey(["search"]))),
    ).toBe(10);
    expect(
      pivot.values.get(pivotCellKey(github, pivotTupleKey(["issues"]))),
    ).toBe(4);
    expect(pivot.grandTotal).toBe(21);
  });

  it("counts unique users in pivot cells", () => {
    const pivot = buildPivot(records, ["server"], [], "uniqueUsers");
    const all = pivotTupleKey(["All"]);
    expect(pivot.values.get(pivotCellKey(pivotTupleKey(["github"]), all))).toBe(
      1,
    );
    expect(pivot.values.get(pivotCellKey(pivotTupleKey(["slack"]), all))).toBe(
      1,
    );
    expect(pivot.columnTotals.get(all)).toBe(2);
    expect(pivot.grandTotal).toBe(2);
  });

  it("derives non-additive pivot column totals from source records", () => {
    const uniqueUsers = buildPivot(records, ["group"], ["tool"], "uniqueUsers");
    const usage = buildPivot(records, ["group"], ["tool"], "usage");

    expect(uniqueUsers.columnTotals.get(pivotTupleKey(["search"]))).toBe(2);
    expect(
      uniqueUsers.rowKeys.reduce(
        (sum, row) =>
          sum +
          (uniqueUsers.values.get(
            pivotCellKey(row, pivotTupleKey(["search"])),
          ) ?? 0),
        0,
      ),
    ).toBe(3);
    expect(usage.columnTotals.get(pivotTupleKey(["search"]))).toBe(17);
  });

  it("cycles daily chart measures", () => {
    expect(dailySeries(records, "usage")).toEqual([
      ["2026-09-01", 10],
      ["2026-09-02", 11],
    ]);
    expect(dailySeries(records, "users")).toEqual([
      ["2026-09-01", 1],
      ["2026-09-02", 2],
    ]);
    expect(dailySeries(records, "servers")).toEqual([
      ["2026-09-01", 1],
      ["2026-09-02", 2],
    ]);
    expect(dailySeries(records, "tools")).toEqual([
      ["2026-09-01", 1],
      ["2026-09-02", 2],
    ]);
  });

  it("builds correctly aggregated nested pivot rows", () => {
    const pivot = buildPivot(records, ["server", "user"], [], "usage");
    const github = pivot.rowTree.find((node) => node.label === "github");
    expect(github?.values.get(pivotTupleKey(["All"]))).toBe(14);
    expect(github?.total).toBe(14);
    expect(github?.children).toHaveLength(1);
    expect(github?.children[0].label).toBe("Alex · alex@example.com");
    expect(github?.children[0].values.get(pivotTupleKey(["All"]))).toBe(14);
    expect(
      pivot.rowTotals.get(pivotTupleKey(["github", "Alex · alex@example.com"])),
    ).toBe(14);
  });

  it("keeps people with the same display name separate in pivots", () => {
    const duplicateName = {
      ...records[2],
      email: "alex.two@example.com",
      displayName: "Alex",
    };
    const pivot = buildPivot(
      [records[0], duplicateName],
      ["user"],
      [],
      "usage",
    );

    expect(new Set(pivot.rowKeys)).toEqual(
      new Set([
        pivotTupleKey(["Alex · alex.two@example.com"]),
        pivotTupleKey(["Alex · alex@example.com"]),
      ]),
    );
    expect(pivot.grandTotal).toBe(17);
  });

  it("keeps arbitrary pivot tuples and cells collision-safe", () => {
    const delimiterRecords = [
      {
        ...records[0],
        server: "a › b",
        tool: "c",
        usage: 2,
      },
      {
        ...records[0],
        server: "a",
        tool: "b › c",
        usage: 3,
      },
    ];
    const rowPivot = buildPivot(
      delimiterRecords,
      ["server", "tool"],
      [],
      "usage",
    );
    const columnPivot = buildPivot(
      delimiterRecords,
      [],
      ["server", "tool"],
      "usage",
    );

    expect(rowPivot.rowKeys).toHaveLength(2);
    expect(new Set(rowPivot.rowLabels.values())).toEqual(
      new Set(["a › b › c"]),
    );
    expect(columnPivot.columnKeys).toHaveLength(2);
    expect(new Set(columnPivot.columnLabels.values())).toEqual(
      new Set(["a › b › c"]),
    );

    const controlRecords = [
      {
        ...records[0],
        server: "a\u0000b",
        tool: "c",
        usage: 5,
      },
      {
        ...records[0],
        server: "a",
        tool: "b\u0000c",
        usage: 7,
      },
    ];
    const cellPivot = buildPivot(controlRecords, ["server"], ["tool"], "usage");

    expect(
      cellPivot.values.get(
        pivotCellKey(pivotTupleKey(["a\u0000b"]), pivotTupleKey(["c"])),
      ),
    ).toBe(5);
    expect(
      cellPivot.values.get(
        pivotCellKey(pivotTupleKey(["a"]), pivotTupleKey(["b\u0000c"])),
      ),
    ).toBe(7);
  });

  it("explodes overlapping group membership without inflating the grand total", () => {
    const pivot = buildPivot(records, ["group"], [], "usage");
    expect(pivot.rowTotals.get(pivotTupleKey(["Engineering"]))).toBe(14);
    expect(pivot.rowTotals.get(pivotTupleKey(["Pilot"]))).toBe(14);
    expect(pivot.rowTotals.get(pivotTupleKey(["Product"]))).toBe(7);
    expect(pivot.grandTotal).toBe(21);
  });

  it("derives sortable temporal grains for filters and pivots", () => {
    expect(temporalValue("2026-09-18", "dates")).toBe("2026-09-18");
    expect(temporalValue("2026-09-18", "days")).toBe("18");
    expect(temporalValue("2026-09-18", "weeks")).toBe("2026-W38");
    expect(temporalValue("2026-09-18", "months")).toBe("September");
    expect(temporalValue("2026-09-18", "monthYears")).toBe("2026-09 · Sep");
    expect(temporalValue("2026-09-18", "quarters")).toBe("2026-Q3");
    expect(temporalValue("2026-09-18", "years")).toBe("2026");
  });

  it("summarizes one observed connection per user and MCP", () => {
    const connections = buildUserMcpConnections(records);
    const github = connections.find(
      (connection) =>
        connection.email === "alex@example.com" &&
        connection.server === "github",
    );

    expect(github).toMatchObject({
      firstObserved: "2026-09-01",
      lastObserved: "2026-09-02",
      activeDays: 2,
      totalCalls: 14,
      tools: ["issues", "search"],
    });
  });
});
