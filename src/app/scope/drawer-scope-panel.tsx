import { useState, type Dispatch, type SetStateAction } from "react";
import type { McpRecord } from "../../contracts/mcp-response";
import type { AssociationOption } from "./associative-model";
import {
  TEMPORAL_FILTER_FIELDS,
  TEMPORAL_FIELD_LABELS,
  isTemporalFilterField,
  type Filters,
  type TemporalFilterField,
} from "./filter-model";
import type { SearchSelection } from "./global-search";
import { Icon } from "../interface/icon";
import { McpServerLabel } from "../relationships/mcp-server-label";
import type { FilterOption } from "./multi-select-filter";
import { ScopeFilters } from "./scope-filters";
import { ScopeSelectionChip } from "./scope-selection-chip";
import { TemporalFilterGroup } from "./temporal-filter-group";
import { countSelections, type SelectionField } from "./selection-model";

export function DrawerScopePanel({
  rangeLabel,
  contextLabel,
  records,
  filters,
  originOptions,
  userOptions,
  serverOptions,
  toolOptions,
  groupOptions,
  timeOptions,
  onChange,
  canResetScope,
  onResetScope,
  lockedFields,
  onToggleLock,
}: {
  rangeLabel: string;
  contextLabel: string;
  records: McpRecord[];
  filters: Filters;
  originOptions: FilterOption[];
  userOptions: FilterOption[];
  serverOptions: FilterOption[];
  toolOptions: FilterOption[];
  groupOptions: FilterOption[];
  timeOptions: Record<TemporalFilterField, AssociationOption[]>;
  onChange: Dispatch<SetStateAction<Filters>>;
  canResetScope: boolean;
  onResetScope: () => void;
  lockedFields: Set<SelectionField>;
  onToggleLock: (field: SelectionField) => void;
}) {
  const [filterRequest, setFilterRequest] = useState<{
    field: SelectionField | "query" | null;
    id: number;
  }>({ field: null, id: 0 });
  const requestedTemporalField = isTemporalFilterField(filterRequest.field)
    ? filterRequest.field
    : undefined;
  const addSelection = (selection: SearchSelection) => {
    const key =
      selection.type === "User"
        ? "users"
        : selection.type === "MCP"
          ? "servers"
          : selection.type === "Tool"
            ? "tools"
            : "groups";
    if (lockedFields.has(key)) return;
    onChange((current) =>
      current[key].includes(selection.value)
        ? current
        : {
            ...current,
            [key]: [...current[key], selection.value],
            query: "",
          },
    );
  };
  const removeSelection = (field: SelectionField, value: string) => {
    onChange((current) => ({
      ...current,
      [field]: current[field].filter((item) => item !== value),
    }));
  };
  const openFilter = (field: SelectionField | "query") => {
    setFilterRequest((current) => ({ field, id: current.id + 1 }));
  };
  const selectedCount = countSelections(filters);

  return (
    <div className="drawer-scope-panel">
      <div className="drawer-breadcrumbs">
        <span>
          <Icon name="filter" size={13} /> Scope
        </span>
        <i>/</i>
        <span>{rangeLabel}</span>
        <i>/</i>
        <strong>{contextLabel}</strong>
        <button type="button" onClick={onResetScope} disabled={!canResetScope}>
          <Icon name="close" size={11} />
          Clear selections
        </button>
      </div>

      {selectedCount > 0 && (
        <div className="drawer-scope-chips">
          {filters.origins.map((value) => (
            <ScopeSelectionChip
              className="origin"
              key={`origin:${value}`}
              locked={lockedFields.has("origins")}
              onOpen={() => openFilter("origins")}
              openLabel={`Open MCP type filter ${value}`}
              onRemove={() => removeSelection("origins", value)}
              removeLabel={`Remove MCP type filter ${value}`}
            >
              <Icon name="server" size={11} />
              {value === "internal" ? "Internal" : "External"}
            </ScopeSelectionChip>
          ))}
          {filters.users.map((value) => (
            <ScopeSelectionChip
              className="user"
              key={`user:${value}`}
              locked={lockedFields.has("users")}
              onOpen={() => openFilter("users")}
              openLabel={`Open user filter ${value}`}
              onRemove={() => removeSelection("users", value)}
              removeLabel={`Remove user filter ${value}`}
            >
              <Icon name="users" size={11} />
              {userOptions.find((option) => option.value === value)?.label ??
                value}
            </ScopeSelectionChip>
          ))}
          {filters.servers.map((value) => (
            <ScopeSelectionChip
              className="server"
              key={`server:${value}`}
              locked={lockedFields.has("servers")}
              onOpen={() => openFilter("servers")}
              openLabel={`Open MCP filter ${value}`}
              onRemove={() => removeSelection("servers", value)}
              removeLabel={`Remove MCP filter ${value}`}
            >
              <Icon name="server" size={11} />
              <McpServerLabel server={value} />
            </ScopeSelectionChip>
          ))}
          {filters.tools.map((value) => (
            <ScopeSelectionChip
              className="tool"
              key={`tool:${value}`}
              locked={lockedFields.has("tools")}
              onOpen={() => openFilter("tools")}
              openLabel={`Open tool filter ${value}`}
              onRemove={() => removeSelection("tools", value)}
              removeLabel={`Remove tool filter ${value}`}
            >
              <Icon name="tools" size={11} />
              {value}
            </ScopeSelectionChip>
          ))}
          {filters.groups.map((value) => (
            <ScopeSelectionChip
              className="group"
              key={`group:${value}`}
              locked={lockedFields.has("groups")}
              onOpen={() => openFilter("groups")}
              openLabel={`Open group filter ${value}`}
              onRemove={() => removeSelection("groups", value)}
              removeLabel={`Remove group filter ${value}`}
            >
              <Icon name="grid" size={11} />
              {value}
            </ScopeSelectionChip>
          ))}
          {TEMPORAL_FILTER_FIELDS.filter(
            (field) => filters[field].length > 0,
          ).map((field) => {
            const values = filters[field];
            const label = TEMPORAL_FIELD_LABELS[field];
            return (
              <ScopeSelectionChip
                className="time"
                key={field}
                locked={lockedFields.has(field)}
                onOpen={() => openFilter(field)}
                openLabel={`Open ${label} selections`}
                onRemove={() =>
                  onChange((current) => ({ ...current, [field]: [] }))
                }
                removeLabel={`Clear ${label} selections`}
              >
                <Icon name="calendar" size={11} />
                {values.length === 1
                  ? `${label}: ${values[0]}`
                  : `${label} · ${values.length} selected`}
              </ScopeSelectionChip>
            );
          })}
          {filters.query && (
            <ScopeSelectionChip
              className="query"
              onOpen={() => openFilter("query")}
              openLabel={`Open search filter ${filters.query}`}
              onRemove={() =>
                onChange((current) => ({ ...current, query: "" }))
              }
              removeLabel={`Remove search filter ${filters.query}`}
            >
              <Icon name="search" size={11} />“{filters.query}”
            </ScopeSelectionChip>
          )}
        </div>
      )}

      <div className="drawer-filter-controls">
        <ScopeFilters
          records={records}
          filters={filters}
          originOptions={originOptions}
          userOptions={userOptions}
          serverOptions={serverOptions}
          toolOptions={toolOptions}
          groupOptions={groupOptions}
          request={filterRequest}
          setFilters={onChange}
          onSearchSelect={addSelection}
          lockedFields={lockedFields}
          onToggleLock={onToggleLock}
        />
        <div className="drawer-temporal-filters">
          <TemporalFilterGroup
            options={timeOptions}
            filters={filters}
            onChange={onChange}
            lockedFields={lockedFields}
            onToggleLock={onToggleLock}
            openRequest={requestedTemporalField ? filterRequest.id : 0}
            openField={requestedTemporalField}
          />
        </div>
      </div>
    </div>
  );
}
