import { CurrentScopeSelections } from "./current-scope-selections";
import { Icon } from "../interface/icon";
import { ScopeExportPanel } from "../exports/scope-export-panel";
import { ScopeFilterWorkspace } from "./scope-filter-workspace";
import type { DashboardScopeBarProps } from "./scope-contract";
import { countSelections, type SelectionField } from "./selection-model";

export function DashboardScopeBar({
  scope,
  navigation,
  filterPanel,
  exportPanel,
}: DashboardScopeBarProps) {
  const activeSelectionCount = countSelections(scope.filters);
  const openScopeFilter = (field: SelectionField | "query") => {
    exportPanel.setOpen(false);
    filterPanel.setOpen(true);
    filterPanel.setRequest((current) => ({
      field,
      id: current.id + 1,
    }));
  };

  return (
    <nav
      ref={scope.barRef}
      className={`selection-bar${scope.stuck ? " is-stuck" : ""}`}
      aria-label="Current analysis scope"
    >
      <CurrentScopeSelections
        scope={scope}
        activeSelectionCount={activeSelectionCount}
        onOpenFilter={openScopeFilter}
      />
      <button
        type="button"
        className={`scope-filter-toggle ${filterPanel.open ? "active" : ""}`}
        onClick={() => {
          exportPanel.setOpen(false);
          filterPanel.setRequest((current) => ({
            ...current,
            field: null,
          }));
          filterPanel.setOpen((open) => !open);
        }}
        aria-expanded={filterPanel.open}
        aria-controls="sticky-filter-workspace"
      >
        <Icon name="filter" size={12} />
        Filters
        {activeSelectionCount > 0 && <strong>{activeSelectionCount}</strong>}
        <span>{filterPanel.open ? "⌃" : "⌄"}</span>
      </button>
      <button
        type="button"
        className="scope-clear global-reset"
        onClick={scope.onReset}
        disabled={!scope.canReset || scope.clearing}
      >
        <Icon name="close" size={12} />
        Clear selections
      </button>
      <div className="dar-nav" aria-label="Dashboard sections">
        <button
          type="button"
          className={
            navigation.activePhase === "dashboard-phase" ? "active" : ""
          }
          aria-pressed={navigation.activePhase === "dashboard-phase"}
          onClick={() => navigation.onSelectPhase("dashboard-phase")}
        >
          Dashboard
        </button>
        <button
          type="button"
          className={
            navigation.activePhase === "analysis-phase" ? "active" : ""
          }
          aria-pressed={navigation.activePhase === "analysis-phase"}
          onClick={() => navigation.onSelectPhase("analysis-phase")}
        >
          Analysis
        </button>
        <button
          type="button"
          className={
            navigation.activePhase === "reporting-phase" ? "active" : ""
          }
          aria-pressed={navigation.activePhase === "reporting-phase"}
          onClick={() => navigation.onSelectPhase("reporting-phase")}
        >
          Reporting
        </button>
      </div>
      <ScopeExportPanel
        scope={scope}
        filterPanel={filterPanel}
        exportPanel={exportPanel}
      />
      <ScopeFilterWorkspace scope={scope} filterPanel={filterPanel} />
    </nav>
  );
}
