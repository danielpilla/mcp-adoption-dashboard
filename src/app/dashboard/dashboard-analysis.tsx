import type { DateRange, McpRecord } from "../../contracts/mcp-response";
import { formatNumber, type DailyMetric } from "../analytics/activity-metrics";
import type { AssociativeModel } from "../scope/associative-model";
import { rangeLabel } from "./dashboard-dates";
import { DashboardPhaseHeader } from "./dashboard-phase-header";
import type { Filters } from "../scope/filter-model";
import { Icon } from "../interface/icon";
import type { McpMomentumResult } from "../analytics/mcp-momentum";
import { McpMomentumPanel } from "../analytics/mcp-momentum-panel";
import { McpServerLabel } from "../relationships/mcp-server-label";
import { NetworkGraph } from "../relationships/mcp-relationship-graph";
import { PivotWorkspace } from "../pivot/pivot-workspace";
import type { PivotResult } from "../pivot/pivot-model";
import { SelectionMark } from "../scope/selection-mark";
import {
  SelectionToolbar,
  type SelectionActionField,
} from "../scope/selection-toolbar";
import type { SelectionField } from "../scope/selection-model";
import { TrendChart } from "../analytics/trend-chart";
import type { VisualSelectionSession } from "../scope/use-dashboard-selections";

interface ServerStat {
  server: string;
  usage: number;
  users: number;
  tools: number;
}

interface AnalysisModel {
  filteredRecords: McpRecord[];
  selectionContextRecords: McpRecord[];
  activeRange: DateRange;
  trendRange: DateRange;
  trendMeasure: {
    value: number;
    label: string;
  };
  evidenceIncludesToday: boolean;
  selectableServerStats: ServerStat[];
  momentumResult: McpMomentumResult;
  selectionOptions: AssociativeModel["options"];
}

interface AnalysisSelection {
  session: VisualSelectionSession | null;
  pendingChangeCount: number;
  lockedFields: Set<SelectionField>;
  filtersForSource: (source: string) => Filters;
  selectedValuesForSource: (source: string, field: SelectionField) => string[];
  actionField: (field: SelectionField, label: string) => SelectionActionField;
}

interface AnalysisActions {
  onClearFilters: () => void;
  onSetTrendMetric: (metric: DailyMetric) => void;
  onSetTrendShowValues: (show: boolean) => void;
  onApplySelections: () => void;
  onCancelSelections: () => void;
  onToggleSelection: (
    source: string,
    field: SelectionField,
    value: string,
  ) => void;
  onAddSelectionValues: (
    source: string,
    field: SelectionField,
    values: string[],
  ) => void;
  onReplaceSelectionValues: (
    source: string,
    field: SelectionField,
    values: string[],
  ) => void;
  onCommitSelection: (field: SelectionField, values: string[]) => void;
  onToggleLock: (field: SelectionField) => void;
  onSelectOther: (kind: "servers" | "users") => void;
  onPivotChange: (pivot: PivotResult | null) => void;
}

export function DashboardAnalysis({
  model,
  selection,
  trend,
  actions,
}: {
  model: AnalysisModel;
  selection: AnalysisSelection;
  trend: {
    metric: DailyMetric;
    showValues: boolean;
  };
  actions: AnalysisActions;
}) {
  const sessionSource = selection.session?.source;
  const trendSelectionActive = sessionSource === "trend";
  const momentumSelectionActive = sessionSource === "momentum";

  return (
    <>
      <DashboardPhaseHeader
        id="analysis-phase"
        number="02"
        label="Analysis"
        question="Why and where is it happening?"
      />

      {model.filteredRecords.length === 0 ? (
        <section
          className="state-card empty-state"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="state-icon">
            <Icon name="filter" size={24} />
          </div>
          <div>
            <h2>No MCP activity matches</h2>
            <p>Clear a filter or choose a broader date range.</p>
          </div>
          <button type="button" onClick={actions.onClearFilters}>
            Clear filters
          </button>
        </section>
      ) : (
        <>
          <section className="dashboard-grid">
            <article className="panel trend-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Activity over time</span>
                  <h2>Daily MCP activity</h2>
                  <p>
                    {rangeLabel(
                      model.activeRange.startDate,
                      model.activeRange.endDate,
                    )}
                  </p>
                </div>
                <div className="trend-heading-actions">
                  <SelectionToolbar
                    active={trendSelectionActive}
                    count={selection.pendingChangeCount}
                    onApply={actions.onApplySelections}
                    onCancel={actions.onCancelSelections}
                    fields={[selection.actionField("dates", "Date")]}
                    onSelectValues={(field, values) =>
                      actions.onReplaceSelectionValues("trend", field, values)
                    }
                  />
                  <label className="trend-metric-picker">
                    <span>Daily measure</span>
                    <select
                      value={trend.metric}
                      onChange={(event) =>
                        actions.onSetTrendMetric(
                          event.target.value as DailyMetric,
                        )
                      }
                    >
                      <option value="usage">MCP calls</option>
                      <option value="users">Distinct users</option>
                      <option value="servers">Observed MCPs</option>
                      <option value="tools">MCP–tool pairs</option>
                    </select>
                  </label>
                  <label className="trend-value-toggle">
                    <input
                      type="checkbox"
                      checked={trend.showValues}
                      onChange={(event) =>
                        actions.onSetTrendShowValues(event.target.checked)
                      }
                    />
                    <span>Show values</span>
                  </label>
                  <span className="chart-instruction">
                    Click points or drag to select dates
                    {model.evidenceIncludesToday &&
                      " · today may be incomplete"}
                  </span>
                  <span className="panel-metric">
                    <i /> {formatNumber(model.trendMeasure.value)}{" "}
                    {model.trendMeasure.label}
                  </span>
                </div>
              </div>
              <TrendChart
                records={
                  trendSelectionActive
                    ? model.selectionContextRecords
                    : model.filteredRecords
                }
                onSelectDates={(dates) =>
                  actions.onAddSelectionValues("trend", "dates", dates)
                }
                onToggleDate={(date) =>
                  actions.onToggleSelection("trend", "dates", date)
                }
                selectedDates={selection.selectedValuesForSource(
                  "trend",
                  "dates",
                )}
                startDate={
                  trendSelectionActive
                    ? model.activeRange.startDate
                    : model.trendRange.startDate
                }
                endDate={
                  trendSelectionActive
                    ? model.activeRange.endDate
                    : model.trendRange.endDate
                }
                metric={trend.metric}
                showValues={trend.showValues}
              />
            </article>

            <article className="panel ranking-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Most-used MCPs</span>
                  <h2>Top observed MCPs</h2>
                  <p>Ranked by calls in the current scope.</p>
                </div>
                <SelectionToolbar
                  active={sessionSource === "server-ranking"}
                  count={selection.pendingChangeCount}
                  onApply={actions.onApplySelections}
                  onCancel={actions.onCancelSelections}
                  fields={[selection.actionField("servers", "MCP server")]}
                  onSelectValues={(field, values) =>
                    actions.onReplaceSelectionValues(
                      "server-ranking",
                      field,
                      values,
                    )
                  }
                />
              </div>
              <div className="server-ranking">
                {model.selectableServerStats
                  .slice(0, 5)
                  .map((server, index) => {
                    const selected = selection
                      .selectedValuesForSource("server-ranking", "servers")
                      .includes(server.server);
                    return (
                      <button
                        type="button"
                        key={server.server}
                        className={`server-rank-row chart-selectable${selected ? " selected" : ""}`}
                        onClick={() =>
                          actions.onToggleSelection(
                            "server-ranking",
                            "servers",
                            server.server,
                          )
                        }
                        aria-pressed={selected}
                        aria-label={`${selected ? "Remove" : "Add"} ${server.server} MCP filter`}
                      >
                        <span className="rank-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="rank-main">
                          <strong>
                            <McpServerLabel server={server.server} />
                          </strong>
                          <span>
                            {server.users} users · {server.tools} tools
                          </span>
                          <i
                            style={{
                              width: `${(server.usage / Math.max(model.selectableServerStats[0]?.usage ?? 1, 1)) * 100}%`,
                            }}
                          />
                        </span>
                        <strong className="rank-usage">
                          {formatNumber(server.usage)}
                        </strong>
                        <SelectionMark selected={selected} />
                      </button>
                    );
                  })}
              </div>
            </article>
          </section>

          <McpMomentumPanel
            result={model.momentumResult}
            selectedServers={selection.selectedValuesForSource(
              "momentum",
              "servers",
            )}
            onToggleServer={(server) =>
              actions.onToggleSelection("momentum", "servers", server)
            }
            selectionActive={momentumSelectionActive}
            pendingChangeCount={selection.pendingChangeCount}
            onApplySelection={actions.onApplySelections}
            onCancelSelection={actions.onCancelSelections}
            selectionFields={[selection.actionField("servers", "MCP server")]}
            onSelectValues={(field, values) =>
              actions.onReplaceSelectionValues("momentum", field, values)
            }
          />

          <section className="panel network-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">User and MCP connections</span>
                <h2>User–MCP relationships</h2>
                <p>Click MCPs or users to filter; click again to remove.</p>
              </div>
              <span className="panel-badge">
                <Icon name="network" size={15} /> Interactive
              </span>
            </div>
            <NetworkGraph
              records={
                sessionSource === "sankey"
                  ? model.selectionContextRecords
                  : model.filteredRecords
              }
              selectedServers={selection.selectedValuesForSource(
                "sankey",
                "servers",
              )}
              selectedUsers={selection.selectedValuesForSource(
                "sankey",
                "users",
              )}
              onToggleServer={(server) =>
                actions.onToggleSelection("sankey", "servers", server)
              }
              onToggleUser={(user) =>
                actions.onToggleSelection("sankey", "users", user)
              }
              selectionActive={sessionSource === "sankey"}
              pendingChangeCount={selection.pendingChangeCount}
              onApplySelection={actions.onApplySelections}
              onCancelSelection={actions.onCancelSelections}
              selectionFields={[
                selection.actionField("servers", "MCP server"),
                selection.actionField("users", "User"),
              ]}
              onSelectValues={(field, values) =>
                actions.onReplaceSelectionValues("sankey", field, values)
              }
              onSelectOther={actions.onSelectOther}
            />
          </section>

          <PivotWorkspace
            records={
              sessionSource === "pivot"
                ? model.selectionContextRecords
                : model.filteredRecords
            }
            onPivotChange={actions.onPivotChange}
            selectedFilters={selection.filtersForSource("pivot")}
            onToggleSelection={(field, value) =>
              actions.onToggleSelection("pivot", field, value)
            }
            onSelectValues={(field, values) =>
              actions.onReplaceSelectionValues("pivot", field, values)
            }
            onCommitSelection={actions.onCommitSelection}
            selectionActive={sessionSource === "pivot"}
            pendingChangeCount={selection.pendingChangeCount}
            onApplySelection={actions.onApplySelections}
            onCancelSelection={actions.onCancelSelections}
            selectionOptions={model.selectionOptions}
            lockedFields={selection.lockedFields}
            onToggleLock={actions.onToggleLock}
          />
        </>
      )}
    </>
  );
}
