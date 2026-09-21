import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { McpRecord } from "../../contracts/mcp-response";
import {
  dailyUsage,
  formatNumber,
  serverUsage,
  toolUsage,
  userUsage,
} from "./activity-metrics";
import { Icon } from "../interface/icon";
import { SelectionMark } from "../scope/selection-mark";
import { ServerUsageRow } from "../relationships/mcp-server-usage-row";
import {
  SelectionToolbar,
  type SelectionActionField,
} from "../scope/selection-toolbar";
import type { SelectionField } from "../scope/selection-model";
import { TrendChart } from "./trend-chart";
import { useDialogFocusTrap } from "../interface/dialog-focus-trap";

export type KpiType = "calls" | "users" | "servers" | "tools";

const TITLES: Record<KpiType, { eyebrow: string; title: string }> = {
  calls: { eyebrow: "Call activity", title: "Observed MCP calls" },
  users: { eyebrow: "MCP users", title: "Active users" },
  servers: { eyebrow: "MCP usage", title: "Observed MCPs" },
  tools: { eyebrow: "Tools used", title: "MCP–tool pairs" },
};

export function KpiDrawer({
  type,
  records,
  onClose,
  onSelectServer,
  onSelectUser,
  onToggleDate,
  selectedServers,
  selectedUsers,
  selectedDates,
  selectionActive,
  pendingChangeCount,
  onApplySelection,
  onCancelSelection,
  selectionFields,
  onSelectValues,
  scopeControls,
}: {
  type: KpiType | null;
  records: McpRecord[];
  onClose: () => void;
  onSelectServer: (server: string) => void;
  onSelectUser: (email: string) => void;
  onToggleDate: (date: string) => void;
  selectedServers: string[];
  selectedUsers: string[];
  selectedDates: string[];
  selectionActive: boolean;
  pendingChangeCount: number;
  onApplySelection: () => void;
  onCancelSelection: () => void;
  selectionFields: SelectionActionField[];
  onSelectValues: (field: SelectionField, values: string[]) => void;
  scopeControls: ReactNode;
}) {
  const dialogRef = useDialogFocusTrap<HTMLElement>(Boolean(type));
  useEffect(() => {
    if (!type) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector(
          ".multi-filter-menu, .temporal-group-menu, .search-results, .selection-actions-popover",
        )
      ) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [type, onClose]);

  const users = useMemo(() => userUsage(records), [records]);
  const servers = useMemo(() => serverUsage(records), [records]);
  const days = useMemo(
    () =>
      dailyUsage(records)
        .map(([date, usage]) => ({ date, usage }))
        .sort((a, b) => b.usage - a.usage),
    [records],
  );
  const tools = useMemo(() => toolUsage(records), [records]);

  if (!type) return null;
  const heading = TITLES[type];

  return (
    <div className="drawer-layer">
      <button
        className="drawer-scrim"
        type="button"
        onClick={onClose}
        aria-label="Dismiss KPI details"
      />
      <aside
        ref={dialogRef}
        className="server-drawer kpi-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kpi-drawer-title"
      >
        <div className="drawer-header">
          <div className="drawer-icon">
            <Icon
              name={
                type === "users"
                  ? "users"
                  : type === "servers"
                    ? "server"
                    : type === "tools"
                      ? "tools"
                      : "activity"
              }
              size={22}
            />
          </div>
          <div>
            <span className="eyebrow">{heading.eyebrow}</span>
            <h2 id="kpi-drawer-title">{heading.title}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close KPI details"
            data-dialog-initial-focus
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-content">
          {scopeControls}
          <div className="drawer-selection-toolbar">
            <SelectionToolbar
              active={selectionActive}
              count={pendingChangeCount}
              onApply={onApplySelection}
              onCancel={onCancelSelection}
              fields={selectionFields}
              onSelectValues={onSelectValues}
            />
          </div>
          {type === "calls" && (
            <>
              <div className="drawer-kpis">
                <div>
                  <strong>
                    {formatNumber(
                      records.reduce((sum, record) => sum + record.usage, 0),
                    )}
                  </strong>
                  <span>Total calls</span>
                </div>
                <div>
                  <strong>{formatNumber(days.length)}</strong>
                  <span>Active days</span>
                </div>
                <div>
                  <strong>{formatNumber(users.length)}</strong>
                  <span>Contributors</span>
                </div>
              </div>
              <div className="drawer-section">
                <div className="drawer-section-title">
                  <h3>Daily call volume</h3>
                  <span>Selected period</span>
                </div>
                <TrendChart
                  records={records}
                  compact
                  gradientId="calls-kpi-gradient"
                />
              </div>
              <KpiList
                title="Peak activity days"
                rows={days.slice(0, 15).map((day) => ({
                  label: day.date,
                  detail: "Daily MCP calls",
                  value: day.usage,
                  selected: selectedDates.includes(day.date),
                  onSelect: () => onToggleDate(day.date),
                }))}
              />
            </>
          )}

          {type === "users" && (
            <KpiList
              title="Users ranked by calls"
              rows={users.map((user) => ({
                label: user.displayName,
                detail: `${user.email} · ${user.tools} tools${user.directoryGroups.length ? ` · ${user.directoryGroups.slice(0, 2).join(", ")}` : ""}`,
                value: user.usage,
                selected: selectedUsers.includes(user.email),
                onSelect: () => onSelectUser(user.email),
              }))}
            />
          )}

          {type === "servers" && (
            <div className="drawer-section kpi-list-section">
              <div className="drawer-section-title">
                <h3>MCPs ranked by calls</h3>
                <span>{servers.length} observed</span>
              </div>
              <div className="kpi-detail-list">
                {servers.map((server, index) => {
                  const selected = selectedServers.includes(server.server);
                  return (
                    <ServerUsageRow
                      key={server.server}
                      server={server}
                      rank={index + 1}
                      selected={selected}
                      onSelect={() => onSelectServer(server.server)}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {type === "tools" && (
            <KpiList
              title="Tools ranked by usage"
              rows={tools.map((tool) => ({
                label: tool.tool,
                detail: `${tool.server} · ${tool.users} users`,
                value: tool.usage,
              }))}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function KpiList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{
    label: string;
    detail: string;
    value: number;
    selected?: boolean;
    onSelect?: () => void;
  }>;
}) {
  const [visibleCount, setVisibleCount] = useState(100);
  const visibleRows = rows.slice(0, visibleCount);

  return (
    <div className="drawer-section kpi-list-section">
      <div className="drawer-section-title">
        <h3>{title}</h3>
        <span>
          Showing {visibleRows.length} of {rows.length}
        </span>
      </div>
      <div className="kpi-detail-list">
        {visibleRows.map((row, index) =>
          row.onSelect ? (
            <button
              type="button"
              className={`kpi-detail-row interactive chart-selectable${row.selected ? " selected" : ""}`}
              key={`${row.label}-${index}`}
              onClick={row.onSelect}
              aria-pressed={Boolean(row.selected)}
              aria-label={`${row.selected ? "Remove" : "Add"} ${row.label} filter`}
            >
              <span className="user-rank">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="kpi-detail-main">
                <strong>{row.label}</strong>
                <small>{row.detail}</small>
              </span>
              <strong>{formatNumber(row.value)}</strong>
              <SelectionMark selected={Boolean(row.selected)} />
            </button>
          ) : (
            <div className="kpi-detail-row" key={`${row.label}-${index}`}>
              <span className="user-rank">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="kpi-detail-main">
                <strong>{row.label}</strong>
                <small>{row.detail}</small>
              </span>
              <strong>{formatNumber(row.value)}</strong>
            </div>
          ),
        )}
        {visibleCount < rows.length && (
          <button
            type="button"
            className="load-more-button"
            onClick={() => setVisibleCount((count) => count + 100)}
          >
            Load 100 more
          </button>
        )}
      </div>
    </div>
  );
}
