import writeXlsxFile, {
  type Sheet,
  type SheetData,
} from "write-excel-file/browser";
import {
  summarizeMcpRecords,
  type DateRange,
  type McpRecord,
  type McpResponse,
} from "../../contracts/mcp-response";
import { groupValueLabel, temporalValue } from "../scope/filter-model";
import { pivotCellKey, type PivotResult } from "../pivot/pivot-model";
import type { UserMcpConnection } from "../reporting/user-mcp-connections";

export interface ExportManifest {
  team: string;
  generatedAt: string;
  exportedAt: string;
  range: DateRange;
  filters: Record<string, string | string[]>;
  lockedFields: string[];
  sourceRecordCount: number;
  exportedRowCount: number;
  exportedGrain: string;
  identityPolicy: string;
}

export type TabularExportFormat = "csv" | "tsv" | "xlsx";

interface TabularData {
  headers: string[];
  rows: unknown[][];
  sheetName: string;
}

interface SnapshotScopeProvenance {
  version: 1;
  exportedAt: string;
  source: {
    kind: McpResponse["source"];
    generatedAt: string;
    range: McpResponse["range"];
    recordCount: number;
  };
  scope: {
    range: McpResponse["range"];
    recordCount: number;
    narrowedFromSource: boolean;
  };
}

function download(content: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function neutralizeSpreadsheetFormula(value: string): string {
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === undefined) break;
    const code = value.charCodeAt(index);
    if (code > 31 && code !== 127 && !/\s/u.test(character)) break;
    index += 1;
  }
  const firstVisibleCharacter = value[index];
  return firstVisibleCharacter !== undefined &&
    ["=", "+", "-", "@"].includes(firstVisibleCharacter)
    ? `'${value}`
    : value;
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const text =
    typeof value === "string" ? neutralizeSpreadsheetFormula(raw) : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tsvCell(value: unknown): string {
  const raw = String(value ?? "");
  const text =
    typeof value === "string" ? neutralizeSpreadsheetFormula(raw) : raw;
  return /[\t"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function manifestRows(manifest: ExportManifest): unknown[][] {
  return [
    ["team", manifest.team],
    ["generated_at", manifest.generatedAt],
    ["exported_at", manifest.exportedAt],
    ["range", `${manifest.range.startDate}/${manifest.range.endDate}`],
    ["filters", JSON.stringify(manifest.filters)],
    ["locked_fields", manifest.lockedFields.join(";")],
    ["source_record_count", manifest.sourceRecordCount],
    ["exported_row_count", manifest.exportedRowCount],
    ["exported_grain", manifest.exportedGrain],
    ["identity_policy", manifest.identityPolicy],
  ];
}

function spreadsheetValue(value: unknown): string | number | boolean {
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value ?? "");
  return neutralizeSpreadsheetFormula(text);
}

function xlsxColumns(data: TabularData) {
  return data.headers.map((header, index) => {
    const values = [
      header,
      ...data.rows.slice(0, 250).map((row) => String(row[index] ?? "")),
    ];
    return {
      width: Math.min(
        48,
        Math.max(12, ...values.map((value) => value.length + 2)),
      ),
    };
  });
}

function xlsxSheet(data: TabularData): Sheet<Blob> {
  const header = data.headers.map((value) => ({
    value,
    fontWeight: "bold" as const,
    textColor: "#FFFFFF",
    backgroundColor: "#0072CE",
  }));
  return {
    data: [
      header,
      ...data.rows.map((row) => row.map(spreadsheetValue)),
    ] as SheetData,
    sheet: data.sheetName.slice(0, 31),
    columns: xlsxColumns(data),
    stickyRowsCount: 1,
  };
}

function serializeDelimited(data: TabularData, delimiter: "," | "\t"): string {
  const cell = delimiter === "," ? csvCell : tsvCell;
  return [
    data.headers.map(cell).join(delimiter),
    ...data.rows.map((row) => row.map(cell).join(delimiter)),
  ].join("\n");
}

async function exportTabular(
  data: TabularData,
  format: TabularExportFormat,
  filenameBase: string,
  manifest?: ExportManifest,
) {
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "csv" ? "," : "\t";
    const mime =
      format === "csv"
        ? "text/csv;charset=utf-8"
        : "text/tab-separated-values;charset=utf-8";
    download(
      serializeDelimited(data, delimiter),
      `${filenameBase}.${format}`,
      mime,
    );
    return;
  }

  const sheets: Sheet<Blob>[] = [];
  if (manifest) {
    const manifestData: TabularData = {
      headers: ["Dashboard export manifest", "v1"],
      rows: manifestRows(manifest),
      sheetName: "Manifest",
    };
    sheets.push({
      ...xlsxSheet(manifestData),
      columns: [{ width: 24 }, { width: 80 }],
    });
  }
  sheets.push(xlsxSheet(data));
  const blob = await writeXlsxFile(sheets, {
    fontFamily: "Arial",
    fontSize: 11,
  }).toBlob();
  download(
    blob,
    `${filenameBase}.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
}

const RECORD_COLUMNS: Array<keyof McpRecord> = [
  "userId",
  "displayName",
  "email",
  "server",
  "tool",
  "usage",
  "origin",
  "role",
  "directoryGroups",
];
const RECORD_TEMPORAL_HEADERS = [
  "date",
  "iso_week",
  "month",
  "month_year",
  "quarter",
  "year",
];

function recordsTable(records: readonly McpRecord[]): TabularData {
  return {
    headers: [...RECORD_TEMPORAL_HEADERS, ...RECORD_COLUMNS],
    rows: records.map((record) => [
      record.date,
      temporalValue(record.date, "weeks"),
      temporalValue(record.date, "months"),
      temporalValue(record.date, "monthYears"),
      temporalValue(record.date, "quarters"),
      temporalValue(record.date, "years"),
      ...RECORD_COLUMNS.map((column) => {
        const value = record[column];
        return Array.isArray(value) ? value.join("; ") : value;
      }),
    ]),
    sheetName: "Activity",
  };
}

export function serializeRecordsCsv(records: readonly McpRecord[]): string {
  return serializeDelimited(recordsTable(records), ",");
}

export async function exportRecordsTable(
  records: readonly McpRecord[],
  format: TabularExportFormat,
  filenameBase: string,
  manifest?: ExportManifest,
) {
  await exportTabular(recordsTable(records), format, filenameBase, manifest);
}

function pivotTable(pivot: PivotResult): TabularData {
  const headerPart = (value: string) => {
    const label = groupValueLabel(value);
    return label.includes(" › ") || label.includes('"')
      ? JSON.stringify(label)
      : label;
  };
  return {
    headers: [
      ...pivot.rowHeaders,
      ...pivot.columnKeys.map((column) => {
        const values = pivot.columnValues.get(column);
        return values
          ? values.map(headerPart).join(" › ")
          : (pivot.columnLabels.get(column) ?? "");
      }),
      "Total",
    ],
    rows: [
      ...pivot.rowKeys.map((row) => [
        ...(pivot.rowValues.get(row) ?? [pivot.rowLabels.get(row) ?? ""]),
        ...pivot.columnKeys.map(
          (column) => pivot.values.get(pivotCellKey(row, column)) ?? 0,
        ),
        pivot.rowTotals.get(row) ?? 0,
      ]),
      [
        ...pivot.rowHeaders.map((_, index) =>
          index === 0 ? "Grand total" : "",
        ),
        ...pivot.columnKeys.map(
          (column) => pivot.columnTotals.get(column) ?? 0,
        ),
        pivot.grandTotal,
      ],
    ],
    sheetName: "Pivot",
  };
}

export function serializePivotCsv(pivot: PivotResult): string {
  return serializeDelimited(pivotTable(pivot), ",");
}

export async function exportPivotTable(
  pivot: PivotResult,
  format: TabularExportFormat,
  filenameBase: string,
  manifest?: ExportManifest,
) {
  await exportTabular(pivotTable(pivot), format, filenameBase, manifest);
}

const USER_MCP_TSV_COLUMNS = [
  ["display_name", (row: UserMcpConnection) => row.displayName],
  ["email", (row: UserMcpConnection) => row.email],
  ["role", (row: UserMcpConnection) => row.role ?? ""],
  [
    "directory_groups",
    (row: UserMcpConnection) => row.directoryGroups.join("; "),
  ],
  ["mcp_server", (row: UserMcpConnection) => row.server],
  ["first_observed", (row: UserMcpConnection) => row.firstObserved],
  ["last_observed", (row: UserMcpConnection) => row.lastObserved],
  ["active_days", (row: UserMcpConnection) => row.activeDays],
  ["total_calls", (row: UserMcpConnection) => row.totalCalls],
  ["distinct_tools", (row: UserMcpConnection) => row.tools.length],
  ["tools", (row: UserMcpConnection) => row.tools.join("; ")],
] as const;

function userMcpTable(rows: readonly UserMcpConnection[]): TabularData {
  return {
    headers: USER_MCP_TSV_COLUMNS.map(([header]) => header),
    rows: rows.map((row) =>
      USER_MCP_TSV_COLUMNS.map(([, value]) => value(row)),
    ),
    sheetName: "User MCP report",
  };
}

export function serializeUserMcpTsv(
  rows: readonly UserMcpConnection[],
): string {
  return serializeDelimited(userMcpTable(rows), "\t");
}

export async function exportUserMcpTable(
  rows: readonly UserMcpConnection[],
  format: TabularExportFormat,
  filenameBase: string,
  manifest?: ExportManifest,
) {
  await exportTabular(userMcpTable(rows), format, filenameBase, manifest);
}

export function serializeEmailsTsv(emails: readonly string[]): string {
  const uniqueEmails = [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return serializeDelimited(
    {
      headers: ["email"],
      rows: uniqueEmails.map((email) => [email]),
      sheetName: "Email addresses",
    },
    "\t",
  );
}

export async function exportEmailsTable(
  emails: readonly string[],
  format: TabularExportFormat,
  filenameBase: string,
  manifest?: ExportManifest,
) {
  const uniqueEmails = [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
  await exportTabular(
    {
      headers: ["email"],
      rows: uniqueEmails.map((email) => [email]),
      sheetName: "Email addresses",
    },
    format,
    filenameBase,
    manifest,
  );
}

type SnapshotPayload = McpResponse & {
  snapshotScope?: SnapshotScopeProvenance;
};

function scopeProvenance(payload: SnapshotPayload): SnapshotScopeProvenance {
  if (payload.snapshotScope) return payload.snapshotScope;
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: {
      kind: payload.source,
      generatedAt: payload.generatedAt,
      range: payload.range,
      recordCount: payload.records.length,
    },
    scope: {
      range: payload.range,
      recordCount: payload.records.length,
      narrowedFromSource: false,
    },
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function serializeSnapshot(payload: SnapshotPayload): string {
  return safeJson({
    ...payload,
    source: "snapshot",
    snapshotScope: scopeProvenance(payload),
  });
}

export function buildScopedSnapshotPayload(
  payload: SnapshotPayload,
  records: McpRecord[],
  range: McpResponse["range"],
): McpResponse & { snapshotScope: SnapshotScopeProvenance } {
  const previousScope = payload.snapshotScope;
  const source = previousScope?.source ?? {
    kind: payload.source,
    generatedAt: payload.generatedAt,
    range: payload.range,
    recordCount: payload.records.length,
  };
  const exportedAt = new Date().toISOString();
  return {
    ...payload,
    records,
    summary: summarizeMcpRecords(records),
    range,
    generatedAt: exportedAt,
    snapshotScope: {
      version: 1,
      exportedAt,
      source,
      scope: {
        range,
        recordCount: records.length,
        narrowedFromSource:
          records.length !== source.recordCount ||
          range.startDate !== source.range.startDate ||
          range.endDate !== source.range.endDate,
      },
    },
  };
}

export function buildSnapshotHtml(
  shell: string,
  payload: SnapshotPayload,
): string {
  const provenance = scopeProvenance(payload);
  const serialized = serializeSnapshot({
    ...payload,
    snapshotScope: provenance,
  });
  if (
    /(?:Basic\s+[A-Za-z0-9+/=]{16,}|(?:key|crsr)_[A-Za-z0-9_-]{12,})/i.test(
      serialized,
    )
  ) {
    throw new Error("Snapshot safety check failed.");
  }
  const manifestTag = `<script id="mcp-snapshot-manifest" type="application/json">${safeJson(provenance)}</script>`;
  const snapshotTag = `<script id="mcp-snapshot" type="application/json">${serialized}</script>`;
  const html = shell.replace("</head>", `${manifestTag}${snapshotTag}</head>`);
  if (html === shell) {
    throw new Error("Dashboard shell is missing a closing head tag.");
  }
  return html;
}

export async function exportHtmlSnapshot(
  payload: McpResponse,
  filename: string,
) {
  const response = await fetch("/", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Could not load the dashboard shell for export.");
  }
  const shell = await response.text();
  const html = buildSnapshotHtml(shell, payload);

  download(html, filename, "text/html;charset=utf-8");
}
