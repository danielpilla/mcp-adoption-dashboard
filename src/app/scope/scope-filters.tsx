import type { Dispatch, SetStateAction } from "react";
import type { McpRecord } from "../../contracts/mcp-response";
import { isMcpOrigin } from "../../contracts/mcp-origin";
import type { Filters } from "./filter-model";
import { GlobalSearch, type SearchSelection } from "./global-search";
import { MultiSelectFilter, type FilterOption } from "./multi-select-filter";
import type { SelectionField } from "./selection-model";

interface ScopeFilterRequest {
  field: SelectionField | "query" | null;
  id: number;
}

export function ScopeFilters({
  records,
  filters,
  originOptions,
  userOptions,
  serverOptions,
  toolOptions,
  groupOptions,
  request,
  setFilters,
  onSearchSelect,
  lockedFields,
  onToggleLock,
}: {
  records: McpRecord[];
  filters: Filters;
  originOptions: FilterOption[];
  userOptions: FilterOption[];
  serverOptions: FilterOption[];
  toolOptions: FilterOption[];
  groupOptions: FilterOption[];
  request: ScopeFilterRequest;
  setFilters: Dispatch<SetStateAction<Filters>>;
  onSearchSelect: (selection: SearchSelection) => void;
  lockedFields: ReadonlySet<SelectionField>;
  onToggleLock: (field: SelectionField) => void;
}) {
  const options: Array<{
    field: "users" | "servers" | "tools" | "groups";
    label: string;
    kind: "users" | "server" | "tools" | "grid";
    values: FilterOption[];
  }> = [
    { field: "users", label: "Users", kind: "users", values: userOptions },
    { field: "servers", label: "MCPs", kind: "server", values: serverOptions },
    { field: "tools", label: "Tools", kind: "tools", values: toolOptions },
    { field: "groups", label: "Groups", kind: "grid", values: groupOptions },
  ];

  return (
    <>
      <GlobalSearch
        records={records}
        value={filters.query}
        openRequest={request.field === "query" ? request.id : 0}
        onChange={(query) => setFilters((current) => ({ ...current, query }))}
        onSelect={onSearchSelect}
      />
      <MultiSelectFilter
        label="MCP type"
        kind="server"
        options={originOptions}
        selected={filters.origins}
        locked={lockedFields.has("origins")}
        openRequest={request.field === "origins" ? request.id : 0}
        onToggleLock={() => onToggleLock("origins")}
        onChange={(origins) =>
          setFilters((current) => ({
            ...current,
            origins: origins.filter(isMcpOrigin),
          }))
        }
      />
      {options.map(({ field, label, kind, values }) => (
        <MultiSelectFilter
          key={field}
          label={label}
          kind={kind}
          options={values}
          selected={filters[field]}
          locked={lockedFields.has(field)}
          openRequest={request.field === field ? request.id : 0}
          onToggleLock={() => onToggleLock(field)}
          onChange={(selected) =>
            setFilters((current) => ({ ...current, [field]: selected }))
          }
        />
      ))}
    </>
  );
}
