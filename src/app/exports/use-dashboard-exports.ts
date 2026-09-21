import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  DateRange,
  McpRecord,
  McpResponse,
} from "../../contracts/mcp-response";
import type { Filters } from "../scope/filter-model";
import type { PivotResult } from "../pivot/pivot-model";
import {
  buildScopedSnapshotPayload,
  exportEmailsTable,
  exportHtmlSnapshot,
  exportPivotTable,
  exportRecordsTable,
  exportUserMcpTable,
  type ExportManifest,
  type TabularExportFormat,
} from "./dashboard-export";
import type { ExportDataset } from "../scope/scope-contract";
import type { SelectionField } from "../scope/selection-model";
import { buildUserMcpConnections } from "../reporting/user-mcp-connections";

interface DashboardExportData {
  response: McpResponse | null;
  records: McpRecord[];
}

interface DashboardExportScope {
  range: DateRange;
  filters: Filters;
  lockedFields: ReadonlySet<SelectionField>;
  filtering: boolean;
}

interface UseDashboardExportsOptions {
  data: DashboardExportData;
  scope: DashboardExportScope;
  setToast: Dispatch<SetStateAction<string>>;
}

interface ExportFormatConfig {
  title: string;
  description: string;
  rowCount: number;
  grain: string;
}

export function useDashboardExports({
  data,
  scope,
  setToast,
}: UseDashboardExportsOptions) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [dataset, setDataset] = useState<ExportDataset | null>(null);
  const [pivot, setPivot] = useState<PivotResult | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const snapshotAvailable = !import.meta.env.DEV;

  const userMcpRows = useMemo(
    () => buildUserMcpConnections(data.records),
    [data.records],
  );
  const userCount = useMemo(
    () => new Set(userMcpRows.map((row) => row.email)).size,
    [userMcpRows],
  );
  const scopedEmails = useMemo(
    () =>
      [...new Set(userMcpRows.map((row) => row.email))].sort((left, right) =>
        left.localeCompare(right),
      ),
    [userMcpRows],
  );

  const closePanel = useCallback((restoreFocus = true) => {
    setPanelOpen(false);
    setSnapshotError("");
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus());
    }
  }, []);

  const closeModal = useCallback(() => {
    setDataset(null);
    window.setTimeout(() => triggerRef.current?.focus());
  }, []);

  const selectDataset = useCallback(
    (nextDataset: ExportDataset) => {
      closePanel(false);
      setDataset(nextDataset);
    },
    [closePanel],
  );

  useEffect(() => {
    if (!panelOpen) return;
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setPanelOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closePanel, panelOpen]);

  const buildManifest = (
    exportedRowCount: number,
    exportedGrain: string,
  ): ExportManifest => ({
    team: data.response?.team?.name ?? "Unknown team",
    generatedAt: data.response?.generatedAt ?? new Date().toISOString(),
    exportedAt: new Date().toISOString(),
    range: scope.range,
    filters: {
      query: scope.filters.query,
      origins: scope.filters.origins,
      users: scope.filters.users,
      servers: scope.filters.servers,
      tools: scope.filters.tools,
      groups: scope.filters.groups,
      dates: scope.filters.dates,
      days: scope.filters.days,
      weeks: scope.filters.weeks,
      months: scope.filters.months,
      monthYears: scope.filters.monthYears,
      quarters: scope.filters.quarters,
      years: scope.filters.years,
    },
    lockedFields: [...scope.lockedFields],
    sourceRecordCount: data.records.length,
    exportedRowCount,
    exportedGrain,
    identityPolicy:
      "Observed MCP server labels are raw source values; aliases are not merged.",
  });

  const config: ExportFormatConfig | null =
    dataset === "activity"
      ? {
          title: "Raw activity records",
          description:
            "One row per date × user × observed MCP label × tool combination.",
          rowCount: data.records.length,
          grain: "Date × user × MCP × tool",
        }
      : dataset === "userMcp"
        ? {
            title: "User–MCP report",
            description:
              "Aggregated evidence for every observed user and MCP relationship.",
            rowCount: userMcpRows.length,
            grain: "User × observed MCP label",
          }
        : dataset === "pivot"
          ? {
              title: "Current pivot table",
              description:
                "The configured pivot dimensions, columns, totals, and measure.",
              rowCount: (pivot?.rowKeys.length ?? 0) + 1,
              grain: "Configured pivot row plus grand total",
            }
          : dataset === "emails"
            ? {
                title: "User email addresses",
                description:
                  "A sorted, deduplicated list of users in the current scope.",
                rowCount: scopedEmails.length,
                grain: "Unique user email",
              }
            : null;

  const downloadDataset = async (format: TabularExportFormat) => {
    if (scope.filtering) {
      setToast("Wait for the current filters to finish updating");
      return;
    }
    const dateSuffix = `${scope.range.startDate}-to-${scope.range.endDate}`;
    if (dataset === "activity") {
      await exportRecordsTable(
        data.records,
        format,
        `mcp-activity-${dateSuffix}`,
        buildManifest(data.records.length, "date × user × MCP label × tool"),
      );
    } else if (dataset === "userMcp") {
      await exportUserMcpTable(
        userMcpRows,
        format,
        `user-mcp-report-${dateSuffix}`,
        buildManifest(userMcpRows.length, "user × observed MCP label"),
      );
    } else if (dataset === "pivot" && pivot) {
      await exportPivotTable(
        pivot,
        format,
        `mcp-pivot-${dateSuffix}`,
        buildManifest(
          pivot.rowKeys.length + 1,
          "configured pivot row plus grand total",
        ),
      );
    } else if (dataset === "emails") {
      await exportEmailsTable(
        scopedEmails,
        format,
        `user-emails-${dateSuffix}`,
        buildManifest(scopedEmails.length, "unique user email"),
      );
    }
    setToast(`${config?.title ?? "Data"} exported as ${format.toUpperCase()}`);
    setDataset(null);
    closePanel();
  };

  const exportSnapshot = async () => {
    if (!data.response) return;
    if (scope.filtering) {
      setSnapshotError("Wait for the current filters to finish updating.");
      return;
    }
    setSnapshotError("");
    try {
      await exportHtmlSnapshot(
        buildScopedSnapshotPayload(data.response, data.records, scope.range),
        `mcp-adoption-${scope.range.startDate}-to-${scope.range.endDate}.html`,
      );
      setToast("Interactive snapshot exported");
      closePanel();
    } catch (snapshotError) {
      setSnapshotError(
        snapshotError instanceof Error
          ? snapshotError.message
          : "Snapshot export failed",
      );
    }
  };

  return {
    panel: {
      open: panelOpen,
      setOpen: setPanelOpen,
      wrapRef,
      triggerRef,
      panelRef,
      pivot,
      snapshotAvailable,
      snapshotError,
      userCount,
      userMcpRowCount: userMcpRows.length,
    },
    modal: {
      config,
      onClose: closeModal,
      onDownload: downloadDataset,
    },
    actions: {
      closePanel,
      selectDataset,
      exportSnapshot,
      setPivot,
    },
  };
}
