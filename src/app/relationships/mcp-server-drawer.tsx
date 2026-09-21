import { useEffect, useMemo, type ReactNode } from "react";
import type { McpRecord } from "../../contracts/mcp-response";
import { formatNumber, userUsage } from "../analytics/activity-metrics";
import { Icon } from "../interface/icon";
import { McpServerLabel } from "./mcp-server-label";
import { TrendChart } from "../analytics/trend-chart";
import { useDialogFocusTrap } from "../interface/dialog-focus-trap";

export function ServerDrawer({
  server,
  records,
  onClose,
  scopeControls,
}: {
  server: string | null;
  records: McpRecord[];
  onClose: () => void;
  scopeControls: ReactNode;
}) {
  const dialogRef = useDialogFocusTrap<HTMLElement>(Boolean(server));
  useEffect(() => {
    if (!server) return;
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
  }, [server, onClose]);

  const serverRecords = useMemo(
    () => records.filter((record) => record.server === server),
    [records, server],
  );
  const users = useMemo(
    () => (server ? userUsage(records, server) : []),
    [records, server],
  );
  const tools = useMemo(() => {
    const totals = new Map<string, number>();
    for (const record of serverRecords) {
      totals.set(record.tool, (totals.get(record.tool) ?? 0) + record.usage);
    }
    return [...totals]
      .map(([tool, usage]) => ({ tool, usage }))
      .sort((a, b) => b.usage - a.usage);
  }, [serverRecords]);
  const total = serverRecords.reduce((sum, record) => sum + record.usage, 0);

  if (!server) return null;

  return (
    <div className="drawer-layer">
      <button
        className="drawer-scrim"
        type="button"
        onClick={onClose}
        aria-label="Close MCP details"
      />
      <aside
        ref={dialogRef}
        className="server-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-drawer-title"
      >
        <div className="drawer-header">
          <div className="drawer-icon">
            <Icon name="server" size={22} />
          </div>
          <div>
            <span className="eyebrow">MCP server</span>
            <h2 id="server-drawer-title">
              <McpServerLabel server={server} />
            </h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close details"
            data-dialog-initial-focus
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-content">
          {scopeControls}
          <div className="drawer-kpis">
            <div>
              <strong>{formatNumber(total)}</strong>
              <span>Total calls</span>
            </div>
            <div>
              <strong>{formatNumber(users.length)}</strong>
              <span>Users</span>
            </div>
            <div>
              <strong>{formatNumber(tools.length)}</strong>
              <span>Tools</span>
            </div>
          </div>
          <div className="drawer-section">
            <div className="drawer-section-title">
              <h3>Usage velocity</h3>
              <span>Daily calls</span>
            </div>
            <TrendChart
              records={serverRecords}
              compact
              gradientId="drawer-trend-gradient"
            />
          </div>
          <div className="drawer-section">
            <div className="drawer-section-title">
              <h3>Tool mix</h3>
              <span>{tools.length} tools</span>
            </div>
            <div className="tool-bars">
              {tools.slice(0, 8).map((tool) => (
                <div className="tool-bar-row" key={tool.tool}>
                  <div className="tool-bar-label">
                    <span>{tool.tool}</span>
                    <strong>{formatNumber(tool.usage)}</strong>
                  </div>
                  <div className="tool-bar-track">
                    <i
                      style={{
                        width: `${Math.max(4, (tool.usage / (tools[0]?.usage || 1)) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="drawer-section">
            <div className="drawer-section-title">
              <h3>Individual users</h3>
              <span>Ranked by calls</span>
            </div>
            <div className="user-list">
              {users.map((user, index) => (
                <div className="user-row" key={user.email}>
                  <span className="user-rank">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="avatar">
                    {user.displayName
                      .split(/\s|[._-]/)
                      .slice(0, 2)
                      .map((part) => part[0]?.toUpperCase())
                      .join("")}
                  </span>
                  <span className="user-identity">
                    <strong>{user.displayName}</strong>
                    <small title={user.directoryGroups.join(", ")}>
                      {user.email}
                      {user.directoryGroups.length > 0 &&
                        ` · ${user.directoryGroups.slice(0, 2).join(", ")}${user.directoryGroups.length > 2 ? ` +${user.directoryGroups.length - 2}` : ""}`}
                    </small>
                  </span>
                  <span className="user-tools">{user.tools} tools</span>
                  <strong className="user-usage">
                    {formatNumber(user.usage)}
                  </strong>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
