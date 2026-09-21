import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DateRange, McpRecord } from "../../contracts/mcp-response";
import { formatNumber } from "../analytics/activity-metrics";
import type { AssociationOption } from "../scope/associative-model";
import { formatIsoDate } from "../dashboard/dashboard-dates";
import {
  groupValueLabel,
  NO_GROUP_VALUE,
  type Filters,
} from "../scope/filter-model";
import { Icon } from "../interface/icon";
import { McpServerLabel } from "../relationships/mcp-server-label";
import { MultiSelectFilter } from "../scope/multi-select-filter";
import { SelectionMark } from "../scope/selection-mark";
import { SelectionToolbar } from "../scope/selection-toolbar";
import type { SelectionField } from "../scope/selection-model";
import {
  buildUserMcpConnections,
  type UserMcpConnection,
} from "./user-mcp-connections";

const PAGE_SIZE = 50;

type SortKey =
  | "displayName"
  | "server"
  | "firstObserved"
  | "lastObserved"
  | "activeDays"
  | "totalCalls"
  | "tools";
type SortDirection = "asc" | "desc";
type AriaSort = "ascending" | "descending" | "none";

function ariaSort(
  key: SortKey,
  activeKey: SortKey,
  direction: SortDirection,
): AriaSort {
  if (key !== activeKey) return "none";
  return direction === "asc" ? "ascending" : "descending";
}

function dateLabel(date: string): string {
  return formatIsoDate(date, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function sortConnections(
  rows: readonly UserMcpConnection[],
  key: SortKey,
  direction: SortDirection,
) {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aValue =
      key === "tools"
        ? a.tools.length
        : key === "activeDays" || key === "totalCalls"
          ? a[key]
          : a[key].toLowerCase();
    const bValue =
      key === "tools"
        ? b.tools.length
        : key === "activeDays" || key === "totalCalls"
          ? b[key]
          : b[key].toLowerCase();
    if (aValue < bValue) return -1 * multiplier;
    if (aValue > bValue) return 1 * multiplier;
    return (
      a.displayName.localeCompare(b.displayName) ||
      a.server.localeCompare(b.server)
    );
  });
}

function SortButton({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  tabIndex,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  tabIndex?: number;
}) {
  const active = activeKey === sortKey;
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      className="inventory-sort"
      onClick={() => onSort(sortKey)}
      aria-label={
        active
          ? `Sort by ${label}, currently ${direction === "asc" ? "ascending" : "descending"}`
          : `Sort by ${label}`
      }
      aria-pressed={active}
    >
      {label}
      <span>{active ? (direction === "asc" ? "↑" : "↓") : "↕"}</span>
    </button>
  );
}

function ReportDimensionButton({
  field,
  value,
  selectedFilters,
  onToggleSelection,
  showSelection,
  label,
  children,
}: {
  field: SelectionField;
  value: string;
  selectedFilters: Filters;
  onToggleSelection: (field: SelectionField, value: string) => void;
  showSelection: boolean;
  label: string;
  children: ReactNode;
}) {
  const selected =
    showSelection &&
    (selectedFilters[field] as readonly string[]).includes(value);
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`inventory-dimension-select chart-selectable${selected ? " selected" : ""}`}
      onClick={() => onToggleSelection(field, value)}
      aria-pressed={selected}
      aria-label={`${selected ? "Remove" : "Add"} ${label} filter`}
    >
      <span>{children}</span>
      <SelectionMark selected={selected} />
    </button>
  );
}

function ReportHeaderFilter({
  field,
  label,
  kind,
  selectedFilters,
  selectionOptions,
  lockedFields,
  onCommitSelection,
  onToggleLock,
  menuAlign = "right",
  triggerTabIndex,
}: {
  field: SelectionField;
  label: string;
  kind: "users" | "server" | "tools" | "grid" | "calendar";
  selectedFilters: Filters;
  selectionOptions: Record<SelectionField, AssociationOption[]>;
  lockedFields: Set<SelectionField>;
  onCommitSelection: (field: SelectionField, values: string[]) => void;
  onToggleLock: (field: SelectionField) => void;
  menuAlign?: "left" | "right";
  triggerTabIndex?: number;
}) {
  return (
    <MultiSelectFilter
      compact
      label={label}
      kind={kind}
      options={selectionOptions[field]}
      selected={selectedFilters[field]}
      onChange={(values) => onCommitSelection(field, values)}
      locked={lockedFields.has(field)}
      onToggleLock={() => onToggleLock(field)}
      menuAlign={menuAlign}
      triggerTabIndex={triggerTabIndex}
    />
  );
}

function InventoryDimensionHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  field,
  kind,
  selectedFilters,
  selectionOptions,
  lockedFields,
  onCommitSelection,
  onToggleLock,
  menuAlign,
  tabIndex,
}: {
  label: string;
  sortKey?: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  field: SelectionField;
  kind: "users" | "server" | "tools" | "grid" | "calendar";
  selectedFilters: Filters;
  selectionOptions: Record<SelectionField, AssociationOption[]>;
  lockedFields: Set<SelectionField>;
  onCommitSelection: (field: SelectionField, values: string[]) => void;
  onToggleLock: (field: SelectionField) => void;
  menuAlign?: "left" | "right";
  tabIndex?: number;
}) {
  return (
    <div className="inventory-header-controls">
      {sortKey ? (
        <SortButton
          label={label}
          sortKey={sortKey}
          activeKey={activeKey}
          direction={direction}
          onSort={onSort}
          tabIndex={tabIndex}
        />
      ) : (
        <span className="inventory-header-label">{label}</span>
      )}
      <ReportHeaderFilter
        field={field}
        label={label}
        kind={kind}
        selectedFilters={selectedFilters}
        selectionOptions={selectionOptions}
        lockedFields={lockedFields}
        onCommitSelection={onCommitSelection}
        onToggleLock={onToggleLock}
        menuAlign={menuAlign}
        triggerTabIndex={tabIndex}
      />
    </div>
  );
}

export function UserMcpReport({
  records,
  range,
  selectedFilters,
  onToggleSelection,
  onSelectValues,
  onCommitSelection,
  selectionActive,
  pendingChangeCount,
  onApplySelection,
  onCancelSelection,
  selectionOptions,
  lockedFields,
  onToggleLock,
}: {
  records: McpRecord[];
  range: DateRange;
  selectedFilters: Filters;
  onToggleSelection: (field: SelectionField, value: string) => void;
  onSelectValues: (field: SelectionField, values: string[]) => void;
  onCommitSelection: (field: SelectionField, values: string[]) => void;
  selectionActive: boolean;
  pendingChangeCount: number;
  onApplySelection: () => void;
  onCancelSelection: () => void;
  selectionOptions: Record<SelectionField, AssociationOption[]>;
  lockedFields: Set<SelectionField>;
  onToggleLock: (field: SelectionField) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("lastObserved");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [page, setPage] = useState(0);
  const [compactCards, setCompactCards] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 560px)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 560px)");
    const update = () => setCompactCards(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const headerTabIndex = compactCards ? -1 : undefined;

  const connections = useMemo(
    () => buildUserMcpConnections(records),
    [records],
  );
  const sorted = useMemo(
    () => sortConnections(connections, sortKey, sortDirection),
    [connections, sortDirection, sortKey],
  );
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const visibleRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const matchedUsers = useMemo(
    () => new Set(sorted.map((connection) => connection.email)),
    [sorted],
  );
  const totalCalls = sorted.reduce(
    (total, connection) => total + connection.totalCalls,
    0,
  );
  const latestActivity = sorted.reduce(
    (latest, connection) =>
      connection.lastObserved > latest ? connection.lastObserved : latest,
    "",
  );

  useEffect(() => {
    setPage(0);
  }, [records, sortDirection, sortKey]);
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);
  const chooseSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(
      key === "displayName" || key === "server" ? "asc" : "desc",
    );
  };
  return (
    <section
      className="panel user-mcp-inventory"
      aria-labelledby="user-mcp-inventory-title"
    >
      <div className="panel-heading inventory-heading">
        <div>
          <span className="eyebrow">
            <Icon name="users" size={14} />
            Observed MCP use
          </span>
          <h2 id="user-mcp-inventory-title">User–MCP report</h2>
          <p>
            Review one row per user–MCP connection in the current global scope.
          </p>
        </div>
        <div className="inventory-heading-side">
          <SelectionToolbar
            active={selectionActive}
            count={pendingChangeCount}
            onApply={onApplySelection}
            onCancel={onCancelSelection}
            fields={[
              {
                field: "users",
                label: "User",
                options: selectionOptions.users,
                locked: lockedFields.has("users"),
                onToggleLock: () => onToggleLock("users"),
              },
              {
                field: "servers",
                label: "MCP server",
                options: selectionOptions.servers,
                locked: lockedFields.has("servers"),
                onToggleLock: () => onToggleLock("servers"),
              },
              {
                field: "groups",
                label: "Group",
                options: selectionOptions.groups,
                locked: lockedFields.has("groups"),
                onToggleLock: () => onToggleLock("groups"),
              },
              {
                field: "tools",
                label: "Tool",
                options: selectionOptions.tools,
                locked: lockedFields.has("tools"),
                onToggleLock: () => onToggleLock("tools"),
              },
              {
                field: "dates",
                label: "Date",
                options: selectionOptions.dates,
                locked: lockedFields.has("dates"),
                onToggleLock: () => onToggleLock("dates"),
              },
            ]}
            onSelectValues={onSelectValues}
          />
          <div className="inventory-range">
            <span>Evidence window</span>
            <strong>
              {dateLabel(range.startDate)} – {dateLabel(range.endDate)}
            </strong>
          </div>
        </div>
      </div>

      <div className="inventory-kpis" aria-label="Inventory result summary">
        <div>
          <span>
            <Icon name="users" size={15} /> Matched users
          </span>
          <strong>{formatNumber(matchedUsers.size)}</strong>
        </div>
        <div>
          <span>
            <Icon name="network" size={15} /> User × MCP links
          </span>
          <strong>{formatNumber(sorted.length)}</strong>
        </div>
        <div>
          <span>
            <Icon name="activity" size={15} /> Total calls
          </span>
          <strong>{formatNumber(totalCalls)}</strong>
        </div>
        <div>
          <span>
            <Icon name="calendar" size={15} /> Latest activity
          </span>
          <strong>{latestActivity ? dateLabel(latestActivity) : "—"}</strong>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div
          className="inventory-empty"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span>
            <Icon name="filter" size={25} />
          </span>
          <h3>No observed users match the global scope</h3>
          <p>Clear a global filter or choose a broader date range above.</p>
        </div>
      ) : (
        <>
          {compactCards && (
            <div className="inventory-mobile-sort">
              <label>
                <span>Sort report by</span>
                <select
                  value={sortKey}
                  onChange={(event) => {
                    const nextKey = event.target.value as SortKey;
                    setSortKey(nextKey);
                    setSortDirection(
                      nextKey === "displayName" || nextKey === "server"
                        ? "asc"
                        : "desc",
                    );
                  }}
                >
                  <option value="displayName">User</option>
                  <option value="server">MCP</option>
                  <option value="firstObserved">First observed</option>
                  <option value="lastObserved">Last used</option>
                  <option value="activeDays">Active days</option>
                  <option value="totalCalls">Calls</option>
                  <option value="tools">Tools</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() =>
                  setSortDirection((current) =>
                    current === "asc" ? "desc" : "asc",
                  )
                }
                aria-label={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`}
              >
                {sortDirection === "asc" ? "Ascending ↑" : "Descending ↓"}
              </button>
            </div>
          )}
          <div
            className="inventory-table-wrap"
            role="region"
            aria-label="User–MCP report results. Press Enter, then use arrow keys to navigate selectable values."
            tabIndex={0}
            onKeyDown={(event) => {
              const controls = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  ".inventory-dimension-select",
                ),
              ];
              if (controls.length === 0) return;
              if (
                event.target === event.currentTarget &&
                (event.key === "Enter" || event.key === "ArrowDown")
              ) {
                event.preventDefault();
                controls[0]?.focus();
                return;
              }
              const index = controls.indexOf(event.target as HTMLButtonElement);
              if (index < 0) return;
              let nextIndex: number;
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                nextIndex = Math.min(index + 1, controls.length - 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                nextIndex = Math.max(index - 1, 0);
              } else if (event.key === "Home") {
                nextIndex = 0;
              } else if (event.key === "End") {
                nextIndex = controls.length - 1;
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.focus();
                return;
              } else {
                return;
              }
              event.preventDefault();
              controls[nextIndex]?.focus();
            }}
          >
            <table className="inventory-table">
              <thead>
                <tr>
                  <th
                    scope="col"
                    aria-sort={ariaSort("displayName", sortKey, sortDirection)}
                  >
                    <InventoryDimensionHeader
                      label="User"
                      sortKey="displayName"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={chooseSort}
                      field="users"
                      kind="users"
                      selectedFilters={selectedFilters}
                      selectionOptions={selectionOptions}
                      lockedFields={lockedFields}
                      onCommitSelection={onCommitSelection}
                      onToggleLock={onToggleLock}
                      menuAlign="left"
                      tabIndex={headerTabIndex}
                    />
                  </th>
                  <th scope="col">
                    <InventoryDimensionHeader
                      label="Groups"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={chooseSort}
                      field="groups"
                      kind="grid"
                      selectedFilters={selectedFilters}
                      selectionOptions={selectionOptions}
                      lockedFields={lockedFields}
                      onCommitSelection={onCommitSelection}
                      onToggleLock={onToggleLock}
                      menuAlign="left"
                      tabIndex={headerTabIndex}
                    />
                  </th>
                  <th
                    scope="col"
                    aria-sort={ariaSort("server", sortKey, sortDirection)}
                  >
                    <InventoryDimensionHeader
                      label="MCP"
                      sortKey="server"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={chooseSort}
                      field="servers"
                      kind="server"
                      selectedFilters={selectedFilters}
                      selectionOptions={selectionOptions}
                      lockedFields={lockedFields}
                      onCommitSelection={onCommitSelection}
                      onToggleLock={onToggleLock}
                      menuAlign="left"
                      tabIndex={headerTabIndex}
                    />
                  </th>
                  <th
                    scope="col"
                    aria-sort={ariaSort(
                      "firstObserved",
                      sortKey,
                      sortDirection,
                    )}
                  >
                    <InventoryDimensionHeader
                      label="First observed"
                      sortKey="firstObserved"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={chooseSort}
                      field="dates"
                      kind="calendar"
                      selectedFilters={selectedFilters}
                      selectionOptions={selectionOptions}
                      lockedFields={lockedFields}
                      onCommitSelection={onCommitSelection}
                      onToggleLock={onToggleLock}
                      menuAlign="left"
                      tabIndex={headerTabIndex}
                    />
                  </th>
                  <th
                    scope="col"
                    aria-sort={ariaSort("lastObserved", sortKey, sortDirection)}
                  >
                    <InventoryDimensionHeader
                      label="Last used"
                      sortKey="lastObserved"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={chooseSort}
                      field="dates"
                      kind="calendar"
                      selectedFilters={selectedFilters}
                      selectionOptions={selectionOptions}
                      lockedFields={lockedFields}
                      onCommitSelection={onCommitSelection}
                      onToggleLock={onToggleLock}
                      tabIndex={headerTabIndex}
                    />
                  </th>
                  <th
                    scope="col"
                    aria-sort={ariaSort("activeDays", sortKey, sortDirection)}
                  >
                    <SortButton
                      label="Active days"
                      sortKey="activeDays"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={chooseSort}
                      tabIndex={headerTabIndex}
                    />
                  </th>
                  <th
                    scope="col"
                    aria-sort={ariaSort("totalCalls", sortKey, sortDirection)}
                  >
                    <SortButton
                      label="Calls"
                      sortKey="totalCalls"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={chooseSort}
                      tabIndex={headerTabIndex}
                    />
                  </th>
                  <th
                    scope="col"
                    aria-sort={ariaSort("tools", sortKey, sortDirection)}
                  >
                    <InventoryDimensionHeader
                      label="Tools"
                      sortKey="tools"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={chooseSort}
                      field="tools"
                      kind="tools"
                      selectedFilters={selectedFilters}
                      selectionOptions={selectionOptions}
                      lockedFields={lockedFields}
                      onCommitSelection={onCommitSelection}
                      onToggleLock={onToggleLock}
                      tabIndex={headerTabIndex}
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((connection) => (
                  <tr key={`${connection.email}\u0000${connection.server}`}>
                    <th scope="row" data-label="User">
                      <ReportDimensionButton
                        field="users"
                        value={connection.email}
                        selectedFilters={selectedFilters}
                        onToggleSelection={onToggleSelection}
                        showSelection={selectionActive}
                        label={connection.displayName}
                      >
                        <span className="inventory-user-select">
                          <span className="inventory-avatar" aria-hidden="true">
                            {connection.displayName
                              .split(/\s|[._-]/)
                              .slice(0, 2)
                              .map((part) => part[0]?.toUpperCase())
                              .join("")}
                          </span>
                          <span className="inventory-user">
                            <strong>{connection.displayName}</strong>
                            <small>{connection.email}</small>
                          </span>
                        </span>
                      </ReportDimensionButton>
                    </th>
                    <td data-label="Groups">
                      <span className="inventory-group-selections">
                        {(connection.directoryGroups.length
                          ? connection.directoryGroups
                          : [NO_GROUP_VALUE]
                        )
                          .slice(0, 2)
                          .map((group) => (
                            <ReportDimensionButton
                              key={group}
                              field="groups"
                              value={group}
                              selectedFilters={selectedFilters}
                              onToggleSelection={onToggleSelection}
                              showSelection={selectionActive}
                              label={groupValueLabel(group)}
                            >
                              {groupValueLabel(group)}
                            </ReportDimensionButton>
                          ))}
                        {connection.directoryGroups.length > 2 && (
                          <small>
                            +{connection.directoryGroups.length - 2}
                          </small>
                        )}
                      </span>
                    </td>
                    <td data-label="MCP">
                      <ReportDimensionButton
                        field="servers"
                        value={connection.server}
                        selectedFilters={selectedFilters}
                        onToggleSelection={onToggleSelection}
                        showSelection={selectionActive}
                        label={connection.server}
                      >
                        <McpServerLabel server={connection.server} />
                      </ReportDimensionButton>
                    </td>
                    <td data-label="First observed">
                      <ReportDimensionButton
                        field="dates"
                        value={connection.firstObserved}
                        selectedFilters={selectedFilters}
                        onToggleSelection={onToggleSelection}
                        showSelection={selectionActive}
                        label={dateLabel(connection.firstObserved)}
                      >
                        {dateLabel(connection.firstObserved)}
                      </ReportDimensionButton>
                    </td>
                    <td data-label="Last used">
                      <ReportDimensionButton
                        field="dates"
                        value={connection.lastObserved}
                        selectedFilters={selectedFilters}
                        onToggleSelection={onToggleSelection}
                        showSelection={selectionActive}
                        label={dateLabel(connection.lastObserved)}
                      >
                        <strong>{dateLabel(connection.lastObserved)}</strong>
                      </ReportDimensionButton>
                    </td>
                    <td data-label="Active days">
                      {formatNumber(connection.activeDays)}
                    </td>
                    <td data-label="Calls">
                      <strong>{formatNumber(connection.totalCalls)}</strong>
                    </td>
                    <td data-label="Tools">
                      <strong>{formatNumber(connection.tools.length)}</strong>
                      <span className="inventory-tool-selections">
                        {connection.tools.slice(0, 2).map((tool) => (
                          <ReportDimensionButton
                            key={tool}
                            field="tools"
                            value={tool}
                            selectedFilters={selectedFilters}
                            onToggleSelection={onToggleSelection}
                            showSelection={selectionActive}
                            label={tool}
                          >
                            {tool}
                          </ReportDimensionButton>
                        ))}
                        {connection.tools.length > 2 && (
                          <small>+{connection.tools.length - 2}</small>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inventory-footer">
            <span role="status" aria-live="polite">
              Showing {page * PAGE_SIZE + 1}–
              {Math.min((page + 1) * PAGE_SIZE, sorted.length)} of{" "}
              {formatNumber(sorted.length)} user–MCP links
            </span>
            {pageCount > 1 && (
              <div
                className="inventory-pagination"
                aria-label="Inventory pages"
              >
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((current) => current - 1)}
                  aria-label="Previous inventory page"
                >
                  ‹
                </button>
                <strong>
                  {page + 1} / {pageCount}
                </strong>
                <button
                  type="button"
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((current) => current + 1)}
                  aria-label="Next inventory page"
                >
                  ›
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
