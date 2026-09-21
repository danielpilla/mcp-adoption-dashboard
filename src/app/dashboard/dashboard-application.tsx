import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  summarizeMcpRecords,
  type McpResponse,
} from "../../contracts/mcp-response";
import {
  formatNumber,
  serverUsage,
  type DailyMetric,
} from "../analytics/activity-metrics";
import { InMemoryAssociativeEngine } from "../scope/associative-model";
import type { Filters } from "../scope/filter-model";
import { DashboardScopeBar } from "../scope/dashboard-scope-bar";
import { DashboardAnalysis } from "./dashboard-analysis";
import { DashboardHeader } from "./dashboard-header";
import { DashboardOverview, type DashboardKpiView } from "./dashboard-overview";
import { DashboardPhaseHeader } from "./dashboard-phase-header";
import { DrawerScopePanel } from "../scope/drawer-scope-panel";
import { ExportFormatModal } from "../exports/export-format-modal";
import type { SearchSelection } from "../scope/global-search";
import { Icon } from "../interface/icon";
import { KpiDrawer, type KpiType } from "../analytics/kpi-drawer";
import { buildMcpMomentum } from "../analytics/mcp-momentum";
import { OverflowDrawer } from "../relationships/relationship-overflow-drawer";
import { ServerDrawer } from "../relationships/mcp-server-drawer";
import { SettingsModal } from "../setup/settings-modal";
import { UserMcpReport } from "../reporting/user-mcp-report";
import {
  inclusiveDayCount,
  isoDate,
  presetRange,
  rangeLabel,
} from "./dashboard-dates";
import { useDashboardData } from "./use-dashboard-data";
import { useDashboardExports } from "../exports/use-dashboard-exports";
import { useDashboardPhaseNavigation } from "./use-dashboard-phase-navigation";
import { useDashboardSelections } from "../scope/use-dashboard-selections";
import { useDialogFocusTrap } from "../interface/dialog-focus-trap";
import {
  clearUnlockedSelections,
  countUnlockedSelections,
  type SelectionField,
} from "../scope/selection-model";
import { buildWeeklyComparison } from "../analytics/kpi-comparison";

function signedValue(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value}${suffix}`;
}

function comparisonTone(value: number | null): DashboardKpiView["deltaTone"] {
  if (value === null || value === 0) return "neutral";
  return value < 0 ? "negative" : "positive";
}

export function App({
  initialData,
  onSetupRequired,
}: {
  initialData: McpResponse | null;
  onSetupRequired?: () => void;
}) {
  const initialRange = useMemo(
    () => initialData?.range ?? presetRange(90),
    [initialData?.range],
  );
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [selectedKpi, setSelectedKpi] = useState<KpiType | null>(null);
  const [selectedOverflow, setSelectedOverflow] = useState<
    "servers" | "users" | null
  >(null);
  const [scopeFiltersOpen, setScopeFiltersOpen] = useState(false);
  const [scopeFilterRequest, setScopeFilterRequest] = useState<{
    field: SelectionField | "query" | null;
    id: number;
  }>({ field: null, id: 0 });
  const [trendMetric, setTrendMetric] = useState<DailyMetric>("usage");
  const [trendShowValues, setTrendShowValues] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [clearingScope, setClearingScope] = useState(false);
  const clearScopeTimerRef = useRef<number | null>(null);
  const startDateInputRef = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState<Filters>({
    query: "",
    origins: initialData?.source === "snapshot" ? [] : ["external"],
    users: [],
    servers: [],
    tools: [],
    groups: [],
    dates: [],
    days: [],
    weeks: [],
    months: [],
    monthYears: [],
    quarters: [],
    years: [],
  });
  const {
    lockedFields,
    selectionSession,
    previewFilters,
    pendingChangeCount,
    toggleFieldLock,
    rejectLockedFieldChange,
    applyPendingSelections,
    cancelPendingSelections,
    togglePendingSelection,
    addPendingSelectionValues,
    replacePendingSelectionValues,
    commitFieldSelection,
  } = useDashboardSelections({
    filters,
    setFilters,
    initialLockedFields: initialData?.source === "snapshot" ? [] : ["origins"],
    setToast,
  });
  const {
    state: {
      data,
      loading,
      blockingLoad,
      refreshError,
      transitionPending: isPending,
      error,
      activeRange,
      draftRange,
    },
    actions: { updateRange, drillToRange, refreshData, retryFailedLoad },
  } = useDashboardData({
    initialData,
    initialRange,
    onSetupRequired,
    onBeforeRangeChange: cancelPendingSelections,
  });
  const isSnapshot = initialData?.source === "snapshot";
  const { activePhase, scopeBarStuck, selectionBarRef, selectPhase } =
    useDashboardPhaseNavigation(Boolean(data));

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(
    () => () => {
      if (clearScopeTimerRef.current !== null) {
        window.clearTimeout(clearScopeTimerRef.current);
      }
    },
    [],
  );

  const deferredFilters = useDeferredValue(filters);
  const rangeRecords = useMemo(
    () =>
      (data?.records ?? []).filter(
        (record) =>
          record.date >= activeRange.startDate &&
          record.date <= activeRange.endDate,
      ),
    [data, activeRange],
  );
  const associativeEngine = useMemo(
    () => new InMemoryAssociativeEngine(rangeRecords),
    [rangeRecords],
  );
  const associativeModel = useMemo(
    () => associativeEngine.evaluate(deferredFilters),
    [associativeEngine, deferredFilters],
  );
  const filteredRecords = associativeModel.records;
  const selectionContextRecords = useMemo(() => {
    if (!selectionSession) return filteredRecords;
    const contextFilters = { ...filters };
    for (const field of Object.keys(
      selectionSession.changes,
    ) as SelectionField[]) {
      contextFilters[field] = [];
    }
    return associativeEngine.evaluate(contextFilters).records;
  }, [associativeEngine, filters, filteredRecords, selectionSession]);
  const serverStats = useMemo(
    () => serverUsage(filteredRecords),
    [filteredRecords],
  );
  const selectableServerStats = useMemo(
    () =>
      serverUsage(
        selectionSession?.source === "server-ranking"
          ? selectionContextRecords
          : associativeModel.contextRecords.servers,
      ),
    [
      associativeModel.contextRecords.servers,
      selectionContextRecords,
      selectionSession?.source,
    ],
  );
  const userOptions = associativeModel.options.users;
  const originOptions = associativeModel.options.origins;
  const serverOptions = associativeModel.options.servers;
  const toolOptions = associativeModel.options.tools;
  const groupOptions = associativeModel.options.groups;
  const timeOptions = {
    dates: associativeModel.options.dates,
    days: associativeModel.options.days,
    weeks: associativeModel.options.weeks,
    months: associativeModel.options.months,
    monthYears: associativeModel.options.monthYears,
    quarters: associativeModel.options.quarters,
    years: associativeModel.options.years,
  };
  const filteredSummary = useMemo(
    () => summarizeMcpRecords(filteredRecords),
    [filteredRecords],
  );
  const comparisonEngine = useMemo(
    () => (data ? new InMemoryAssociativeEngine(data.records) : null),
    [data],
  );
  const comparisonRecords = useMemo(
    () => comparisonEngine?.evaluate(deferredFilters).records ?? [],
    [comparisonEngine, deferredFilters],
  );
  const committedTemporalSelectionCount =
    filters.dates.length +
    filters.days.length +
    filters.weeks.length +
    filters.months.length +
    filters.monthYears.length +
    filters.quarters.length +
    filters.years.length;
  const filteredDateExtent = useMemo(() => {
    const dates = filteredRecords
      .map((record) => record.date)
      .sort((left, right) => left.localeCompare(right));
    const startDate = dates[0];
    if (!startDate) return null;
    return { startDate, endDate: dates.at(-1) ?? startDate };
  }, [filteredRecords]);
  const originScopeLabel =
    filters.origins.length === 1
      ? `${filters.origins[0] === "external" ? "External" : "Internal"} MCP activity`
      : filters.origins.length === 0
        ? "All MCP activity"
        : "Selected MCP activity";
  const callsPerActiveUser =
    filteredSummary.uniqueUsers > 0
      ? Math.round(filteredSummary.totalUsage / filteredSummary.uniqueUsers)
      : 0;
  const toolsPerMcp =
    filteredSummary.uniqueServers > 0
      ? Math.round(filteredSummary.uniqueTools / filteredSummary.uniqueServers)
      : 0;
  const evidenceThrough = filteredDateExtent?.endDate ?? activeRange.endDate;
  const today = isoDate(new Date());
  const activeRangeIncludesToday = activeRange.endDate === today;
  const evidenceIncludesToday = evidenceThrough === today;
  const weeklyComparison = useMemo(
    () =>
      data
        ? buildWeeklyComparison(
            comparisonRecords,
            activeRange,
            data.range,
            activeRangeIncludesToday,
          )
        : null,
    [activeRange, activeRangeIncludesToday, comparisonRecords, data],
  );
  const weeklyActivityLabel =
    weeklyComparison?.current.totalUsage === 0
      ? "Latest 7d · no activity"
      : null;
  const overviewKpis: DashboardKpiView[] = [
    {
      type: "calls",
      label: "Observed MCP calls",
      value: filteredSummary.totalUsage,
      icon: "activity",
      note: `${formatNumber(callsPerActiveUser)} per active user`,
      delta:
        weeklyActivityLabel ??
        (weeklyComparison
          ? `Latest 7d ${
              weeklyComparison.calls === null
                ? "· no prior activity"
                : signedValue(weeklyComparison.calls, "%")
            }`
          : "Prior 7 days unavailable"),
      deltaTone:
        weeklyActivityLabel || !weeklyComparison
          ? "neutral"
          : comparisonTone(weeklyComparison.calls),
    },
    {
      type: "users",
      label: "Active users",
      value: filteredSummary.uniqueUsers,
      icon: "users",
      note: "People observed using MCP in this scope",
      delta:
        weeklyActivityLabel ??
        (weeklyComparison
          ? `Latest 7d ${signedValue(weeklyComparison.users)} users`
          : "Prior 7 days unavailable"),
      deltaTone:
        weeklyActivityLabel || !weeklyComparison
          ? "neutral"
          : comparisonTone(weeklyComparison.users),
    },
    {
      type: "servers",
      label: "Observed MCPs",
      value: filteredSummary.uniqueServers,
      icon: "server",
      note: "Raw labels; aliases are not merged",
      delta:
        weeklyActivityLabel ??
        (weeklyComparison
          ? `Latest 7d ${signedValue(weeklyComparison.servers)} labels`
          : "Prior 7 days unavailable"),
      deltaTone:
        weeklyActivityLabel || !weeklyComparison
          ? "neutral"
          : comparisonTone(weeklyComparison.servers),
    },
    {
      type: "tools",
      label: "MCP–tool pairs",
      value: filteredSummary.uniqueTools,
      icon: "tools",
      note: `${toolsPerMcp} pairs per observed MCP`,
      delta:
        weeklyActivityLabel ??
        (weeklyComparison
          ? `Latest 7d ${signedValue(weeklyComparison.tools)} pairs`
          : "Prior 7 days unavailable"),
      deltaTone:
        weeklyActivityLabel || !weeklyComparison
          ? "neutral"
          : comparisonTone(weeklyComparison.tools),
    },
  ];
  const trendSelectionActive = selectionSession?.source === "trend";
  const trendRange =
    !trendSelectionActive &&
    committedTemporalSelectionCount > 0 &&
    filteredDateExtent
      ? filteredDateExtent
      : activeRange;
  const filtersForSelectionSource = (source: string) =>
    selectionSession?.source === source ? previewFilters : filters;
  const selectedValuesForSource = (source: string, field: SelectionField) =>
    selectionSession?.source === source
      ? previewFilters[field]
      : filters[field];
  const momentumSelectionActive = selectionSession?.source === "momentum";
  const momentumFilters = momentumSelectionActive ? previewFilters : filters;
  const momentumRecords = momentumSelectionActive
    ? selectionContextRecords
    : associativeModel.contextRecords.servers;
  const momentumResult = useMemo(
    () =>
      buildMcpMomentum(
        momentumRecords,
        activeRange,
        momentumFilters,
        activeRangeIncludesToday,
      ),
    [activeRange, activeRangeIncludesToday, momentumFilters, momentumRecords],
  );
  const selectionActionField = (field: SelectionField, label: string) => ({
    field,
    label,
    options: associativeModel.options[field],
    locked: lockedFields.has(field),
    onToggleLock: () => toggleFieldLock(field),
  });
  const busy = loading;
  const loadingDialogRef = useDialogFocusTrap<HTMLDivElement>(blockingLoad);
  const filtering = deferredFilters !== filters || isPending;
  const loadingDays = inclusiveDayCount(draftRange);
  const loadingWindows = Math.max(1, Math.ceil(loadingDays / 30));
  const refreshedAt = data
    ? new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(data.generatedAt))
    : "";
  const addSearchSelection = (selection: SearchSelection) => {
    const field: SelectionField =
      selection.type === "User"
        ? "users"
        : selection.type === "MCP"
          ? "servers"
          : selection.type === "Tool"
            ? "tools"
            : "groups";
    if (rejectLockedFieldChange(field)) return;
    setFilters((current) => {
      return current[field].includes(selection.value)
        ? current
        : { ...current, [field]: [...current[field], selection.value] };
    });
  };
  const clearFilters = () => {
    cancelPendingSelections();
    setFilters((current) => clearUnlockedSelections(current, lockedFields));
  };
  const clearableSelectionCount = countUnlockedSelections(
    filters,
    lockedFields,
  );
  const dateNarrowed = Boolean(
    data &&
    (activeRange.startDate !== data.range.startDate ||
      activeRange.endDate !== data.range.endDate),
  );
  const canResetScope = Boolean(
    clearableSelectionCount ||
    selectionSession ||
    dateNarrowed ||
    selectedKpi ||
    selectedServer ||
    selectedOverflow,
  );
  const resetGlobalScope = () => {
    setClearingScope(true);
    if (clearScopeTimerRef.current !== null) {
      window.clearTimeout(clearScopeTimerRef.current);
    }
    clearFilters();
    if (data) updateRange(data.range);
    setSelectedKpi(null);
    setSelectedServer(null);
    setSelectedOverflow(null);
    clearScopeTimerRef.current = window.setTimeout(() => {
      setClearingScope(false);
      clearScopeTimerRef.current = null;
    }, 720);
  };
  const trendMeasure =
    trendMetric === "usage"
      ? { value: filteredSummary.totalUsage, label: "calls" }
      : trendMetric === "users"
        ? { value: filteredSummary.uniqueUsers, label: "distinct users" }
        : trendMetric === "servers"
          ? { value: filteredSummary.uniqueServers, label: "observed MCPs" }
          : { value: filteredSummary.uniqueTools, label: "MCP–tool pairs" };
  const dashboardExports = useDashboardExports({
    data: {
      response: data,
      records: filteredRecords,
    },
    scope: {
      range: activeRange,
      filters,
      lockedFields,
      filtering,
    },
    setToast,
  });
  const drawerScopeControls = (
    <DrawerScopePanel
      rangeLabel={rangeLabel(activeRange.startDate, activeRange.endDate)}
      contextLabel={
        selectedServer
          ? `MCP · ${selectedServer}`
          : selectedOverflow
            ? `Other ${selectedOverflow}`
            : selectedKpi
              ? `KPI · ${selectedKpi}`
              : "Dashboard"
      }
      records={rangeRecords}
      filters={filters}
      originOptions={originOptions}
      userOptions={userOptions}
      serverOptions={serverOptions}
      toolOptions={toolOptions}
      groupOptions={groupOptions}
      timeOptions={timeOptions}
      onChange={setFilters}
      canResetScope={canResetScope}
      onResetScope={resetGlobalScope}
      lockedFields={lockedFields}
      onToggleLock={toggleFieldLock}
    />
  );

  return (
    <div className="app-shell">
      <div className="ambient-glow ambient-one" />
      <div className="ambient-glow ambient-two" />
      <a className="skip-link" href="#dashboard-content">
        Skip to dashboard content
      </a>
      <DashboardHeader
        activePhase={activePhase}
        status={{
          data,
          isSnapshot,
          refreshedAt,
          busy,
        }}
        range={{
          active: activeRange,
          draft: draftRange,
          startDateInputRef,
          onUpdate: updateRange,
        }}
        search={{
          records: rangeRecords,
          value: filters.query,
          filtering,
          onChange: (query) => setFilters((current) => ({ ...current, query })),
          onSelect: addSearchSelection,
        }}
        actions={{
          onOpenSettings: () => setSettingsOpen(true),
          onRefresh: refreshData,
        }}
      >
        <DashboardScopeBar
          scope={{
            barRef: selectionBarRef,
            stuck: scopeBarStuck,
            rangeLabel: rangeLabel(activeRange.startDate, activeRange.endDate),
            currentRange: activeRange,
            fullRange: data?.range,
            dataAvailable: Boolean(data),
            isSnapshot,
            filters,
            setFilters,
            lockedFields,
            canReset: canResetScope,
            clearing: clearingScope,
            selectedKpi,
            selectedServer,
            selectedOverflow,
            userOptions,
            onEditRange: () => startDateInputRef.current?.focus(),
            onResetRange: drillToRange,
            onReset: resetGlobalScope,
            onCloseKpi: () => setSelectedKpi(null),
            onCloseServer: () => setSelectedServer(null),
            onCloseOverflow: () => setSelectedOverflow(null),
          }}
          navigation={{
            activePhase,
            onSelectPhase: selectPhase,
          }}
          filterPanel={{
            open: scopeFiltersOpen,
            setOpen: setScopeFiltersOpen,
            request: scopeFilterRequest,
            setRequest: setScopeFilterRequest,
            records: rangeRecords,
            options: {
              origins: originOptions,
              users: userOptions,
              servers: serverOptions,
              tools: toolOptions,
              groups: groupOptions,
              time: timeOptions,
            },
            onSearchSelect: addSearchSelection,
            onToggleLock: toggleFieldLock,
          }}
          exportPanel={{
            open: dashboardExports.panel.open,
            setOpen: dashboardExports.panel.setOpen,
            wrapRef: dashboardExports.panel.wrapRef,
            triggerRef: dashboardExports.panel.triggerRef,
            panelRef: dashboardExports.panel.panelRef,
            busy,
            filtering,
            summary: filteredSummary,
            activityRowCount: filteredRecords.length,
            userCount: dashboardExports.panel.userCount,
            userMcpRowCount: dashboardExports.panel.userMcpRowCount,
            pivot: dashboardExports.panel.pivot,
            snapshotAvailable: dashboardExports.panel.snapshotAvailable,
            snapshotError: dashboardExports.panel.snapshotError,
            onClose: dashboardExports.actions.closePanel,
            onSelectDataset: dashboardExports.actions.selectDataset,
            onSnapshot: () => void dashboardExports.actions.exportSnapshot(),
          }}
        />

        {error && (
          <section
            className="state-card error-state"
            role="alert"
            aria-labelledby="data-error-title"
          >
            <div className="state-icon">!</div>
            <div>
              <h2 id="data-error-title">
                {refreshError && data
                  ? "Refresh failed · showing previous data"
                  : "Data connection interrupted"}
              </h2>
              <p>
                {error}
                {refreshError &&
                  data &&
                  " The dashboard remains on the last successful dataset shown below."}
              </p>
            </div>
            <button type="button" onClick={retryFailedLoad}>
              Try again
            </button>
          </section>
        )}

        {busy && !data ? (
          <section className="loading-dashboard">
            <div className="skeleton-grid">
              {[0, 1, 2, 3].map((item) => (
                <div className="skeleton" key={item} />
              ))}
            </div>
            <div className="skeleton panel-skeleton" />
          </section>
        ) : (
          data && (
            <>
              <DashboardOverview
                scope={{
                  originLocked: lockedFields.has("origins"),
                  originLabel: originScopeLabel,
                  evidenceThrough,
                  evidenceIncludesToday,
                }}
                kpis={overviewKpis}
                summary={filteredSummary}
                leadingServer={serverStats[0]}
                actions={{
                  onSelectKpi: setSelectedKpi,
                  onSelectServer: setSelectedServer,
                }}
              />

              <DashboardAnalysis
                model={{
                  filteredRecords,
                  selectionContextRecords,
                  activeRange,
                  trendRange,
                  trendMeasure,
                  evidenceIncludesToday,
                  selectableServerStats,
                  momentumResult,
                  selectionOptions: associativeModel.options,
                }}
                selection={{
                  session: selectionSession,
                  pendingChangeCount,
                  lockedFields,
                  filtersForSource: filtersForSelectionSource,
                  selectedValuesForSource,
                  actionField: selectionActionField,
                }}
                trend={{
                  metric: trendMetric,
                  showValues: trendShowValues,
                }}
                actions={{
                  onClearFilters: clearFilters,
                  onSetTrendMetric: setTrendMetric,
                  onSetTrendShowValues: setTrendShowValues,
                  onApplySelections: applyPendingSelections,
                  onCancelSelections: cancelPendingSelections,
                  onToggleSelection: togglePendingSelection,
                  onAddSelectionValues: addPendingSelectionValues,
                  onReplaceSelectionValues: replacePendingSelectionValues,
                  onCommitSelection: commitFieldSelection,
                  onToggleLock: toggleFieldLock,
                  onSelectOther: (kind) => {
                    setSelectedServer(null);
                    setSelectedKpi(null);
                    setSelectedOverflow(kind);
                  },
                  onPivotChange: dashboardExports.actions.setPivot,
                }}
              />

              <DashboardPhaseHeader
                id="reporting-phase"
                number="03"
                label="Reporting"
                question="Who is involved, and what can I export?"
              />

              <UserMcpReport
                records={
                  selectionSession?.source === "report"
                    ? selectionContextRecords
                    : filteredRecords
                }
                range={activeRange}
                selectedFilters={filtersForSelectionSource("report")}
                onToggleSelection={(field, value) =>
                  togglePendingSelection("report", field, value)
                }
                onSelectValues={(field, values) =>
                  replacePendingSelectionValues("report", field, values)
                }
                onCommitSelection={commitFieldSelection}
                selectionActive={selectionSession?.source === "report"}
                pendingChangeCount={pendingChangeCount}
                onApplySelection={applyPendingSelections}
                onCancelSelection={cancelPendingSelections}
                selectionOptions={associativeModel.options}
                lockedFields={lockedFields}
                onToggleLock={toggleFieldLock}
              />
            </>
          )
        )}
      </DashboardHeader>

      <footer>
        <div className="footer-brand">
          <span className="brand-mark footer-mark" aria-hidden="true">
            <Icon name="network" size={15} />
          </span>
          <span>Cursor MCP Adoption Dashboard</span>
        </div>
        <div>
          {data && `Generated ${new Date(data.generatedAt).toLocaleString()}`}
          <span className="footer-dot" />
          Employee usage data · Handle appropriately
        </div>
      </footer>

      {dashboardExports.modal.config && (
        <ExportFormatModal
          title={dashboardExports.modal.config.title}
          description={dashboardExports.modal.config.description}
          rowCount={dashboardExports.modal.config.rowCount}
          grain={dashboardExports.modal.config.grain}
          onClose={dashboardExports.modal.onClose}
          onDownload={dashboardExports.modal.onDownload}
        />
      )}

      <KpiDrawer
        type={selectedKpi}
        records={
          selectionSession?.source.startsWith("kpi-")
            ? selectionContextRecords
            : selectedKpi === "users"
              ? associativeModel.contextRecords.users
              : selectedKpi === "servers"
                ? associativeModel.contextRecords.servers
                : selectedKpi === "tools"
                  ? associativeModel.contextRecords.tools
                  : associativeModel.contextRecords.dates
        }
        onClose={() => {
          if (selectionSession?.source.startsWith("kpi-")) {
            cancelPendingSelections();
          }
          setSelectedKpi(null);
        }}
        onSelectServer={(server) =>
          togglePendingSelection("kpi-servers", "servers", server)
        }
        onSelectUser={(user) =>
          togglePendingSelection("kpi-users", "users", user)
        }
        onToggleDate={(date) =>
          togglePendingSelection("kpi-calls", "dates", date)
        }
        selectedServers={selectedValuesForSource(
          `kpi-${selectedKpi}`,
          "servers",
        )}
        selectedUsers={selectedValuesForSource(`kpi-${selectedKpi}`, "users")}
        selectedDates={selectedValuesForSource(`kpi-${selectedKpi}`, "dates")}
        selectionActive={selectionSession?.source === `kpi-${selectedKpi}`}
        pendingChangeCount={pendingChangeCount}
        onApplySelection={applyPendingSelections}
        onCancelSelection={cancelPendingSelections}
        selectionFields={
          selectedKpi === "users"
            ? [selectionActionField("users", "User")]
            : selectedKpi === "servers"
              ? [selectionActionField("servers", "MCP server")]
              : selectedKpi === "tools"
                ? [selectionActionField("tools", "Tool")]
                : [selectionActionField("dates", "Date")]
        }
        onSelectValues={(field, values) =>
          replacePendingSelectionValues(`kpi-${selectedKpi}`, field, values)
        }
        scopeControls={drawerScopeControls}
      />
      <ServerDrawer
        server={selectedServer}
        records={filteredRecords}
        onClose={() => setSelectedServer(null)}
        scopeControls={drawerScopeControls}
      />
      <OverflowDrawer
        kind={selectedOverflow}
        records={
          selectionSession?.source.startsWith("overflow-")
            ? selectionContextRecords
            : associativeModel.networkRecords
        }
        scopeControls={drawerScopeControls}
        onClose={() => {
          if (selectionSession?.source.startsWith("overflow-")) {
            cancelPendingSelections();
          }
          setSelectedOverflow(null);
        }}
        onSelectServer={(server) =>
          togglePendingSelection("overflow-servers", "servers", server)
        }
        onSelectUser={(user) =>
          togglePendingSelection("overflow-users", "users", user)
        }
        selectedServers={selectedValuesForSource(
          `overflow-${selectedOverflow}`,
          "servers",
        )}
        selectedUsers={selectedValuesForSource(
          `overflow-${selectedOverflow}`,
          "users",
        )}
        selectionActive={
          selectionSession?.source === `overflow-${selectedOverflow}`
        }
        pendingChangeCount={pendingChangeCount}
        onApplySelection={applyPendingSelections}
        onCancelSelection={cancelPendingSelections}
        selectionFields={
          selectedOverflow === "users"
            ? [selectionActionField("users", "User")]
            : [selectionActionField("servers", "MCP server")]
        }
        onSelectValues={(field, values) =>
          replacePendingSelectionValues(
            `overflow-${selectedOverflow}`,
            field,
            values,
          )
        }
      />
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onRotated={() => {
            setSettingsOpen(false);
            setToast("API key updated. Refreshing dashboard data…");
            refreshData();
          }}
        />
      )}
      {clearingScope && (
        <div
          className="clear-scope-transition"
          role="status"
          aria-live="polite"
        >
          <span className="clear-scope-icon">
            <Icon name="filter" size={16} />
          </span>
          <span className="clear-scope-copy">
            <strong>Resetting analysis</strong>
            <small>Restoring the full unlocked scope</small>
            <i aria-hidden="true">
              <b />
            </i>
          </span>
        </div>
      )}
      {blockingLoad && (
        <div
          className="loading-layer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="loading-title"
          aria-describedby="loading-description"
        >
          <div ref={loadingDialogRef} className="loading-modal" tabIndex={-1}>
            <div className="loading-orbit">
              <span />
              <Icon name="network" size={24} />
            </div>
            <span className="eyebrow">
              {data ? "Refreshing data" : "Connecting to Cursor"}
            </span>
            <h2 id="loading-title">
              {data ? "Updating MCP activity" : "Loading MCP activity"}
            </h2>
            <p id="loading-description">
              Loading {loadingDays} days of activity
              {loadingWindows > 1 ? ` in ${loadingWindows} date ranges` : ""}.
            </p>
            <div
              className="loading-progress"
              role="status"
              aria-live="polite"
              aria-label="Loading MCP analytics"
            >
              <i />
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Icon name="spark" size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
