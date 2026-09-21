import {
  TEMPORAL_FILTER_FIELDS,
  TEMPORAL_FIELD_LABELS,
  groupValueLabel,
} from "./filter-model";
import { Icon } from "../interface/icon";
import { McpServerLabel } from "../relationships/mcp-server-label";
import { ScopeSelectionChip } from "./scope-selection-chip";
import type { ScopeState } from "./scope-contract";
import type { SelectionField } from "./selection-model";

const SCOPE_VISIBLE_SELECTIONS = 4;

function ScopeMore({
  count,
  label,
  onOpen,
}: {
  count: number;
  label: string;
  onOpen: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      className="scope-chip summary"
      onClick={onOpen}
      aria-label={`Open filters to review ${count} more ${label}`}
    >
      +{count} more {label}
    </button>
  );
}

export function CurrentScopeSelections({
  scope,
  activeSelectionCount,
  onOpenFilter,
}: {
  scope: ScopeState;
  activeSelectionCount: number;
  onOpenFilter: (field: SelectionField | "query") => void;
}) {
  const fullRange = scope.fullRange;
  const temporalSelectionGroups = TEMPORAL_FILTER_FIELDS.filter(
    (field) => scope.filters[field].length > 0,
  );
  const dateNarrowed = Boolean(
    fullRange &&
    (scope.currentRange.startDate !== fullRange.startDate ||
      scope.currentRange.endDate !== fullRange.endDate),
  );

  return (
    <>
      <span className="selection-bar-title">
        <Icon name="filter" size={14} />
        Scope
      </span>
      <span className="scope-separator">/</span>
      <span className={`scope-range${dateNarrowed ? " narrowed" : ""}`}>
        <button
          type="button"
          className="scope-range-main"
          onClick={scope.onEditRange}
          disabled={!scope.dataAvailable || scope.isSnapshot}
          aria-label="Edit analysis date range"
        >
          {scope.rangeLabel}
        </button>
        {dateNarrowed && fullRange && (
          <button
            type="button"
            className="scope-range-remove"
            onClick={() => scope.onResetRange(fullRange)}
            aria-label="Reset to the full loaded date range"
          >
            ×
          </button>
        )}
      </span>
      {activeSelectionCount === 0 ? (
        <>
          <span className="scope-separator">/</span>
          <span className="scope-all">
            All MCP types · All users · All MCPs · All tools
          </span>
        </>
      ) : (
        <>
          {scope.filters.origins.map((value) => (
            <ScopeSelectionChip
              className="origin"
              key={`origin:${value}`}
              locked={scope.lockedFields.has("origins")}
              onOpen={() => onOpenFilter("origins")}
              openLabel={`Open MCP type filter ${value}`}
              onRemove={() =>
                scope.setFilters((current) => ({
                  ...current,
                  origins: current.origins.filter((item) => item !== value),
                }))
              }
              removeLabel={`Remove MCP type filter ${value}`}
            >
              <Icon name="server" size={12} />
              {value === "internal" ? "Internal" : "External"}
            </ScopeSelectionChip>
          ))}
          {scope.filters.users
            .slice(0, SCOPE_VISIBLE_SELECTIONS)
            .map((value) => (
              <ScopeSelectionChip
                className="user"
                key={`user:${value}`}
                locked={scope.lockedFields.has("users")}
                onOpen={() => onOpenFilter("users")}
                openLabel={`Open user filter ${value}`}
                onRemove={() =>
                  scope.setFilters((current) => ({
                    ...current,
                    users: current.users.filter((item) => item !== value),
                  }))
                }
                removeLabel={`Remove user filter ${value}`}
              >
                <Icon name="users" size={12} />
                {scope.userOptions.find((option) => option.value === value)
                  ?.label ?? value}
              </ScopeSelectionChip>
            ))}
          <ScopeMore
            count={scope.filters.users.length - SCOPE_VISIBLE_SELECTIONS}
            label="users"
            onOpen={() => onOpenFilter("users")}
          />
          {scope.filters.servers
            .slice(0, SCOPE_VISIBLE_SELECTIONS)
            .map((value) => (
              <ScopeSelectionChip
                className="server"
                key={`server:${value}`}
                locked={scope.lockedFields.has("servers")}
                onOpen={() => onOpenFilter("servers")}
                openLabel={`Open MCP filter ${value}`}
                onRemove={() =>
                  scope.setFilters((current) => ({
                    ...current,
                    servers: current.servers.filter((item) => item !== value),
                  }))
                }
                removeLabel={`Remove MCP filter ${value}`}
              >
                <Icon name="server" size={12} />
                <McpServerLabel server={value} />
              </ScopeSelectionChip>
            ))}
          <ScopeMore
            count={scope.filters.servers.length - SCOPE_VISIBLE_SELECTIONS}
            label="MCPs"
            onOpen={() => onOpenFilter("servers")}
          />
          {scope.filters.tools
            .slice(0, SCOPE_VISIBLE_SELECTIONS)
            .map((value) => (
              <ScopeSelectionChip
                className="tool"
                key={`tool:${value}`}
                locked={scope.lockedFields.has("tools")}
                onOpen={() => onOpenFilter("tools")}
                openLabel={`Open tool filter ${value}`}
                onRemove={() =>
                  scope.setFilters((current) => ({
                    ...current,
                    tools: current.tools.filter((item) => item !== value),
                  }))
                }
                removeLabel={`Remove tool filter ${value}`}
              >
                <Icon name="tools" size={12} />
                {value}
              </ScopeSelectionChip>
            ))}
          <ScopeMore
            count={scope.filters.tools.length - SCOPE_VISIBLE_SELECTIONS}
            label="tools"
            onOpen={() => onOpenFilter("tools")}
          />
          {scope.filters.groups
            .slice(0, SCOPE_VISIBLE_SELECTIONS)
            .map((value) => (
              <ScopeSelectionChip
                className="group"
                key={`group:${value}`}
                locked={scope.lockedFields.has("groups")}
                onOpen={() => onOpenFilter("groups")}
                openLabel={`Open group filter ${value}`}
                onRemove={() =>
                  scope.setFilters((current) => ({
                    ...current,
                    groups: current.groups.filter((item) => item !== value),
                  }))
                }
                removeLabel={`Remove group filter ${value}`}
              >
                <Icon name="grid" size={12} />
                {groupValueLabel(value)}
              </ScopeSelectionChip>
            ))}
          <ScopeMore
            count={scope.filters.groups.length - SCOPE_VISIBLE_SELECTIONS}
            label="groups"
            onOpen={() => onOpenFilter("groups")}
          />
          {temporalSelectionGroups
            .slice(0, SCOPE_VISIBLE_SELECTIONS)
            .map((field) => {
              const values = scope.filters[field];
              const label = TEMPORAL_FIELD_LABELS[field];
              return (
                <ScopeSelectionChip
                  className="time"
                  key={field}
                  locked={scope.lockedFields.has(field)}
                  onOpen={() => onOpenFilter(field)}
                  openLabel={`Open ${label} selections`}
                  onRemove={() =>
                    scope.setFilters((current) => ({
                      ...current,
                      [field]: [],
                    }))
                  }
                  removeLabel={`Clear ${label} selections`}
                >
                  <Icon name="calendar" size={12} />
                  {values.length === 1
                    ? `${label}: ${values[0]}`
                    : `${label} · ${values.length} selected`}
                </ScopeSelectionChip>
              );
            })}
          <ScopeMore
            count={temporalSelectionGroups.length - SCOPE_VISIBLE_SELECTIONS}
            label="time fields"
            onOpen={() => onOpenFilter(temporalSelectionGroups[0] ?? "dates")}
          />
          {scope.filters.query && (
            <ScopeSelectionChip
              className="query"
              onOpen={() => onOpenFilter("query")}
              openLabel={`Open search filter ${scope.filters.query}`}
              onRemove={() =>
                scope.setFilters((current) => ({ ...current, query: "" }))
              }
              removeLabel={`Remove search filter ${scope.filters.query}`}
            >
              <Icon name="search" size={12} />“{scope.filters.query}”
            </ScopeSelectionChip>
          )}
        </>
      )}
      {scope.selectedKpi && (
        <ScopeSelectionChip
          className="drill"
          onRemove={scope.onCloseKpi}
          removeLabel={`Close ${scope.selectedKpi} exploration`}
        >
          Exploring {scope.selectedKpi}
        </ScopeSelectionChip>
      )}
      {scope.selectedServer && (
        <ScopeSelectionChip
          className="drill"
          onRemove={scope.onCloseServer}
          removeLabel={`Close ${scope.selectedServer} inspection`}
        >
          Inspecting <McpServerLabel server={scope.selectedServer} />
        </ScopeSelectionChip>
      )}
      {scope.selectedOverflow && (
        <ScopeSelectionChip
          className="drill"
          onRemove={scope.onCloseOverflow}
          removeLabel={`Close other ${scope.selectedOverflow} exploration`}
        >
          Exploring other {scope.selectedOverflow}
        </ScopeSelectionChip>
      )}
    </>
  );
}
