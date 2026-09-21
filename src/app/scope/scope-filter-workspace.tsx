import { isTemporalFilterField } from "./filter-model";
import { Icon } from "../interface/icon";
import { ScopeFilters } from "./scope-filters";
import type { FilterPanelState, ScopeState } from "./scope-contract";
import { TemporalFilterGroup } from "./temporal-filter-group";

export function ScopeFilterWorkspace({
  scope,
  filterPanel,
}: {
  scope: ScopeState;
  filterPanel: FilterPanelState;
}) {
  if (!filterPanel.open) return null;

  const requestedTemporalField = isTemporalFilterField(
    filterPanel.request.field,
  )
    ? filterPanel.request.field
    : undefined;

  return (
    <div className="sticky-filter-workspace" id="sticky-filter-workspace">
      <div className="sticky-filter-header">
        <div>
          <span className="eyebrow">Filters</span>
          <strong>Refine the current view</strong>
        </div>
        <button
          type="button"
          onClick={() => {
            filterPanel.setOpen(false);
            filterPanel.setRequest((current) => ({
              ...current,
              field: null,
            }));
          }}
          aria-label="Close sticky filters"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="sticky-filter-primary">
        <ScopeFilters
          records={filterPanel.records}
          filters={scope.filters}
          originOptions={filterPanel.options.origins}
          userOptions={filterPanel.options.users}
          serverOptions={filterPanel.options.servers}
          toolOptions={filterPanel.options.tools}
          groupOptions={filterPanel.options.groups}
          request={filterPanel.request}
          setFilters={scope.setFilters}
          onSearchSelect={filterPanel.onSearchSelect}
          lockedFields={scope.lockedFields}
          onToggleLock={filterPanel.onToggleLock}
        />
      </div>
      <div className="sticky-filter-temporal">
        <TemporalFilterGroup
          options={filterPanel.options.time}
          filters={scope.filters}
          onChange={scope.setFilters}
          lockedFields={scope.lockedFields}
          onToggleLock={filterPanel.onToggleLock}
          openRequest={requestedTemporalField ? filterPanel.request.id : 0}
          openField={requestedTemporalField}
        />
      </div>
    </div>
  );
}
