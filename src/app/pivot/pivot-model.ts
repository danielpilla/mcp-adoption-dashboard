import type { McpRecord } from "../../contracts/mcp-response";
import {
  groupValueLabel,
  NO_GROUP_VALUE,
  temporalValue,
} from "../scope/filter-model";

export type Dimension =
  | "server"
  | "tool"
  | "user"
  | "group"
  | "date"
  | "day"
  | "week"
  | "month"
  | "monthYear"
  | "quarter"
  | "year";
export type PivotValue = "usage" | "uniqueUsers";

export interface PivotResult {
  rowKeys: string[];
  rowHeaders: string[];
  rowLabels: Map<string, string>;
  rowValues: Map<string, string[]>;
  columnKeys: string[];
  columnLabels: Map<string, string>;
  columnValues: Map<string, string[]>;
  columnTotals: Map<string, number>;
  values: Map<string, number>;
  rowTotals: Map<string, number>;
  grandTotal: number;
  rowTree: PivotTreeNode[];
}

export interface PivotTreeNode {
  key: string;
  label: string;
  depth: number;
  values: Map<string, number>;
  total: number;
  children: PivotTreeNode[];
}

export const DIMENSION_LABELS: Record<Dimension, string> = {
  server: "MCP server",
  tool: "Tool",
  user: "User",
  group: "Group",
  date: "Date",
  day: "Day",
  week: "ISO week",
  month: "Month",
  monthYear: "Month-Year",
  quarter: "Quarter",
  year: "Year",
};

export function dimensionValue(
  record: McpRecord,
  dimension: Dimension,
): string {
  if (dimension === "user") {
    const displayName = record.displayName.trim();
    return displayName &&
      displayName.toLowerCase() !== record.email.toLowerCase()
      ? `${displayName} · ${record.email}`
      : record.email;
  }
  if (dimension === "group") {
    return (record.directoryGroups ?? []).join("; ") || NO_GROUP_VALUE;
  }
  if (dimension === "date") return temporalValue(record.date, "dates");
  if (dimension === "day") return temporalValue(record.date, "days");
  if (dimension === "week") return temporalValue(record.date, "weeks");
  if (dimension === "month") return temporalValue(record.date, "months");
  if (dimension === "monthYear")
    return temporalValue(record.date, "monthYears");
  if (dimension === "quarter") return temporalValue(record.date, "quarters");
  if (dimension === "year") return temporalValue(record.date, "years");
  return record[dimension];
}

function dimensionPaths(
  record: McpRecord,
  dimensions: Dimension[],
): string[][] {
  if (dimensions.length === 0) return [["All"]];
  return dimensions.reduce<string[][]>(
    (paths, dimension) => {
      const values =
        dimension === "group"
          ? [
              ...new Set(
                record.directoryGroups?.length
                  ? record.directoryGroups
                  : [NO_GROUP_VALUE],
              ),
            ]
          : [dimensionValue(record, dimension)];
      return paths.flatMap((path) => values.map((value) => [...path, value]));
    },
    [[]],
  );
}

const PIVOT_LABEL_DELIMITER = " › ";

export function pivotTupleKey(values: readonly string[]): string {
  return JSON.stringify(values);
}

export function pivotCellKey(rowKey: string, columnKey: string): string {
  return pivotTupleKey([rowKey, columnKey]);
}

function pivotTupleLabel(values: readonly string[]): string {
  return values.map(groupValueLabel).join(PIVOT_LABEL_DELIMITER);
}

export function buildPivot(
  records: McpRecord[],
  rows: Dimension[],
  columns: Dimension[],
  value: PivotValue,
): PivotResult {
  const rowKeys = new Set<string>();
  const rowLabels = new Map<string, string>();
  const rowValues = new Map<string, string[]>();
  const columnKeys = new Set<string>();
  const columnLabels = new Map<string, string>();
  const columnValues = new Map<string, string[]>();
  const buckets = new Map<string, { usage: number; users: Set<string> }>();
  const columnTotalBuckets = new Map<
    string,
    { usage: number; users: Set<string> }
  >();
  const rowTotalBuckets = new Map<
    string,
    { usage: number; users: Set<string> }
  >();
  const grandUsers = new Set<string>();
  type Bucket = { usage: number; users: Set<string> };
  type TreeAccumulator = {
    key: string;
    label: string;
    depth: number;
    buckets: Map<string, Bucket>;
    totalBucket: Bucket;
    children: Map<string, TreeAccumulator>;
  };
  const treeRoots = new Map<string, TreeAccumulator>();
  let grandUsage = 0;

  for (const record of records) {
    const rowPaths = dimensionPaths(record, rows);
    const columnPaths = dimensionPaths(record, columns);
    for (const columnPath of columnPaths) {
      const columnKey = pivotTupleKey(columnPath);
      columnKeys.add(columnKey);
      columnLabels.set(columnKey, pivotTupleLabel(columnPath));
      columnValues.set(columnKey, columnPath);
      const columnTotalBucket = columnTotalBuckets.get(columnKey) ?? {
        usage: 0,
        users: new Set<string>(),
      };
      columnTotalBucket.usage += record.usage;
      columnTotalBucket.users.add(record.email);
      columnTotalBuckets.set(columnKey, columnTotalBucket);
    }
    for (const pathValues of rowPaths) {
      const rowKey = pivotTupleKey(pathValues);
      rowKeys.add(rowKey);
      rowLabels.set(rowKey, pivotTupleLabel(pathValues));
      rowValues.set(rowKey, pathValues);
      const rowTotalBucket = rowTotalBuckets.get(rowKey) ?? {
        usage: 0,
        users: new Set<string>(),
      };
      rowTotalBucket.usage += record.usage;
      rowTotalBucket.users.add(record.email);
      rowTotalBuckets.set(rowKey, rowTotalBucket);

      const pathNodes: TreeAccumulator[] = [];
      let siblings = treeRoots;
      for (const [depth, label] of pathValues.entries()) {
        const path = pathValues.slice(0, depth + 1);
        const key = pivotTupleKey(path);
        const node = siblings.get(label) ?? {
          key,
          label,
          depth,
          buckets: new Map<string, Bucket>(),
          totalBucket: { usage: 0, users: new Set<string>() },
          children: new Map<string, TreeAccumulator>(),
        };
        node.totalBucket.usage += record.usage;
        node.totalBucket.users.add(record.email);
        siblings.set(label, node);
        pathNodes.push(node);
        siblings = node.children;
      }

      for (const columnPath of columnPaths) {
        const columnKey = pivotTupleKey(columnPath);
        const bucketKey = pivotCellKey(rowKey, columnKey);
        const bucket = buckets.get(bucketKey) ?? {
          usage: 0,
          users: new Set<string>(),
        };
        bucket.usage += record.usage;
        bucket.users.add(record.email);
        buckets.set(bucketKey, bucket);
        for (const node of pathNodes) {
          const nodeBucket = node.buckets.get(columnKey) ?? {
            usage: 0,
            users: new Set<string>(),
          };
          nodeBucket.usage += record.usage;
          nodeBucket.users.add(record.email);
          node.buckets.set(columnKey, nodeBucket);
        }
      }
    }
    grandUsage += record.usage;
    grandUsers.add(record.email);
  }

  const sortedRows = [...rowKeys].sort(
    (a, b) =>
      (rowLabels.get(a) ?? "").localeCompare(rowLabels.get(b) ?? "") ||
      a.localeCompare(b),
  );
  const sortedColumns = [...columnKeys].sort(
    (a, b) =>
      (columnLabels.get(a) ?? "").localeCompare(columnLabels.get(b) ?? "") ||
      a.localeCompare(b),
  );
  const values = new Map<string, number>();
  for (const [key, bucket] of buckets) {
    values.set(key, value === "usage" ? bucket.usage : bucket.users.size);
  }
  const rowTotals = new Map(
    [...rowTotalBuckets].map(([row, bucket]) => [
      row,
      value === "usage" ? bucket.usage : bucket.users.size,
    ]),
  );
  const columnTotals = new Map(
    [...columnTotalBuckets].map(([column, bucket]) => [
      column,
      value === "usage" ? bucket.usage : bucket.users.size,
    ]),
  );
  const buildTree = (
    accumulators: Map<string, TreeAccumulator>,
  ): PivotTreeNode[] =>
    [...accumulators.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((node) => ({
        key: node.key,
        label: node.label,
        depth: node.depth,
        values: new Map(
          [...node.buckets].map(([column, bucket]) => [
            column,
            value === "usage" ? bucket.usage : bucket.users.size,
          ]),
        ),
        total:
          value === "usage"
            ? node.totalBucket.usage
            : node.totalBucket.users.size,
        children: buildTree(node.children),
      }));

  return {
    rowKeys: sortedRows,
    rowHeaders: rows.length
      ? rows.map((dimension) => DIMENSION_LABELS[dimension])
      : ["All"],
    rowLabels,
    rowValues,
    columnKeys: sortedColumns,
    columnLabels,
    columnValues,
    columnTotals,
    values,
    rowTotals,
    grandTotal: value === "usage" ? grandUsage : grandUsers.size,
    rowTree: buildTree(treeRoots),
  };
}
