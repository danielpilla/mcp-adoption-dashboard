import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { McpRecord } from "../../contracts/mcp-response";
import {
  formatNumber,
  serverUsage,
  userUsage,
} from "../analytics/activity-metrics";
import { Icon } from "../interface/icon";
import { SelectionMark } from "../scope/selection-mark";
import { ServerUsageRow } from "./mcp-server-usage-row";
import {
  SelectionToolbar,
  type SelectionActionField,
} from "../scope/selection-toolbar";
import type { SelectionField } from "../scope/selection-model";
import { useDialogFocusTrap } from "../interface/dialog-focus-trap";
import {
  SANKEY_SERVER_LIMIT,
  SANKEY_USER_LIMIT,
} from "./mcp-relationship-graph";

export function OverflowDrawer({
  kind,
  records,
  scopeControls,
  onClose,
  onSelectServer,
  onSelectUser,
  selectedServers,
  selectedUsers,
  selectionActive,
  pendingChangeCount,
  onApplySelection,
  onCancelSelection,
  selectionFields,
  onSelectValues,
}: {
  kind: "servers" | "users" | null;
  records: McpRecord[];
  scopeControls: ReactNode;
  onClose: () => void;
  onSelectServer: (server: string) => void;
  onSelectUser: (email: string) => void;
  selectedServers: string[];
  selectedUsers: string[];
  selectionActive: boolean;
  pendingChangeCount: number;
  onApplySelection: () => void;
  onCancelSelection: () => void;
  selectionFields: SelectionActionField[];
  onSelectValues: (field: SelectionField, values: string[]) => void;
}) {
  const dialogRef = useDialogFocusTrap<HTMLElement>(Boolean(kind));
  const [visibleCount, setVisibleCount] = useState(100);
  const servers = useMemo(
    () => serverUsage(records).slice(SANKEY_SERVER_LIMIT),
    [records],
  );
  const users = useMemo(
    () => userUsage(records).slice(SANKEY_USER_LIMIT),
    [records],
  );

  useEffect(() => {
    setVisibleCount(100);
  }, [kind, records]);

  useEffect(() => {
    if (!kind) return;
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
  }, [kind, onClose]);

  if (!kind) return null;
  const isServers = kind === "servers";
  const totalItems = isServers ? servers.length : users.length;
  const visibleServers = servers.slice(0, visibleCount);
  const visibleUsers = users.slice(0, visibleCount);
  const totalUsage = (isServers ? servers : users).reduce(
    (sum, item) => sum + item.usage,
    0,
  );

  return (
    <div className="drawer-layer">
      <button
        className="drawer-scrim"
        type="button"
        onClick={onClose}
        aria-label="Dismiss other entities"
      />
      <aside
        ref={dialogRef}
        className="server-drawer overflow-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="overflow-drawer-title"
      >
        <div className="drawer-header">
          <div className="drawer-icon">
            <Icon name={isServers ? "server" : "users"} size={22} />
          </div>
          <div>
            <span className="eyebrow">Long-tail adoption</span>
            <h2 id="overflow-drawer-title">
              Other {isServers ? "MCPs" : "users"}
            </h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close other entities"
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
          <div className="drawer-kpis">
            <div>
              <strong>{formatNumber(totalItems)}</strong>
              <span>{isServers ? "MCP servers" : "Users"}</span>
            </div>
            <div>
              <strong>{formatNumber(totalUsage)}</strong>
              <span>Combined calls</span>
            </div>
            <div>
              <strong>
                {formatNumber(
                  isServers ? SANKEY_SERVER_LIMIT : SANKEY_USER_LIMIT,
                )}
              </strong>
              <span>Shown in Sankey</span>
            </div>
          </div>
          <div className="drawer-section">
            <div className="drawer-section-title">
              <h3>{isServers ? "Remaining MCP servers" : "Remaining users"}</h3>
              <span>Ranked by calls</span>
            </div>
            <div className="kpi-detail-list">
              {isServers
                ? visibleServers.map((server, index) => {
                    const selected = selectedServers.includes(server.server);
                    return (
                      <ServerUsageRow
                        key={server.server}
                        server={server}
                        rank={index + SANKEY_SERVER_LIMIT + 1}
                        selected={selected}
                        onSelect={() => onSelectServer(server.server)}
                      />
                    );
                  })
                : visibleUsers.map((user, index) => {
                    const selected = selectedUsers.includes(user.email);
                    return (
                      <button
                        type="button"
                        className={`kpi-detail-row interactive chart-selectable${selected ? " selected" : ""}`}
                        key={user.email}
                        onClick={() => onSelectUser(user.email)}
                        aria-pressed={selected}
                      >
                        <span className="user-rank">
                          {String(index + SANKEY_USER_LIMIT + 1).padStart(
                            2,
                            "0",
                          )}
                        </span>
                        <span className="kpi-detail-main">
                          <strong>{user.displayName}</strong>
                          <small>
                            {user.email} · {user.tools} tools
                            {user.directoryGroups.length
                              ? ` · ${user.directoryGroups.slice(0, 2).join(", ")}`
                              : ""}
                          </small>
                        </span>
                        <strong>{formatNumber(user.usage)}</strong>
                        <SelectionMark selected={selected} />
                      </button>
                    );
                  })}
              {visibleCount < totalItems && (
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
        </div>
      </aside>
    </div>
  );
}
