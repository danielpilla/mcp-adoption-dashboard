import { formatNumber } from "../analytics/activity-metrics";
import { Icon } from "../interface/icon";
import type {
  ExportPanelState,
  FilterPanelState,
  ScopeState,
} from "../scope/scope-contract";

export function ScopeExportPanel({
  scope,
  filterPanel,
  exportPanel,
}: {
  scope: ScopeState;
  filterPanel: FilterPanelState;
  exportPanel: ExportPanelState;
}) {
  return (
    <div className="scope-export-wrap" ref={exportPanel.wrapRef}>
      <button
        ref={exportPanel.triggerRef}
        type="button"
        className="scope-export-button"
        onClick={() => {
          filterPanel.setOpen(false);
          filterPanel.setRequest((current) => ({
            ...current,
            field: null,
          }));
          exportPanel.setOpen((open) => !open);
        }}
        disabled={
          !scope.dataAvailable || exportPanel.busy || exportPanel.filtering
        }
        aria-haspopup="dialog"
        aria-expanded={exportPanel.open}
        aria-controls="scope-export-panel"
      >
        <Icon name="download" size={14} />
        Export current scope
      </button>
      {exportPanel.open && (
        <div
          ref={exportPanel.panelRef}
          className="scope-export-panel"
          id="scope-export-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="scope-export-title"
        >
          <div className="scope-export-header">
            <div>
              <span className="eyebrow">Available exports</span>
              <h2 id="scope-export-title">Export current scope</h2>
              <p>
                Every output uses the visible date range and all active global
                filters.
              </p>
            </div>
            <button
              type="button"
              onClick={() => exportPanel.onClose()}
              aria-label="Close export center"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
          <div className="scope-export-summary">
            <span>{formatNumber(exportPanel.summary.totalUsage)} calls</span>
            <span>
              {formatNumber(exportPanel.activityRowCount)} activity rows
            </span>
            <span>{formatNumber(exportPanel.userCount)} users</span>
            <span>
              {formatNumber(exportPanel.userMcpRowCount)} user–MCP links
            </span>
          </div>
          <div className="scope-export-group">
            <span>Data files</span>
            <button
              type="button"
              className="scope-export-option"
              disabled={exportPanel.activityRowCount === 0}
              onClick={() => exportPanel.onSelectDataset("activity")}
            >
              <i>
                <Icon name="grid" size={16} />
              </i>
              <span>
                <strong>
                  Raw activity records <em>CSV · TSV · XLSX</em>
                </strong>
                <small>
                  {exportPanel.activityRowCount
                    ? "One row per date × user × MCP × tool combination."
                    : "No activity rows match the current scope."}
                </small>
              </span>
              <b>{formatNumber(exportPanel.activityRowCount)} rows</b>
            </button>
            <button
              type="button"
              className="scope-export-option recommended"
              disabled={exportPanel.userMcpRowCount === 0}
              onClick={() => exportPanel.onSelectDataset("userMcp")}
            >
              <i>
                <Icon name="users" size={16} />
              </i>
              <span>
                <strong>
                  User–MCP report <em>CSV · TSV · XLSX</em>
                  <mark>Recommended</mark>
                </strong>
                <small>
                  {exportPanel.userMcpRowCount
                    ? "One aggregated row per user × MCP connection."
                    : "No user–MCP links match the current scope."}
                </small>
              </span>
              <b>{formatNumber(exportPanel.userMcpRowCount)} links</b>
            </button>
            <button
              type="button"
              className="scope-export-option"
              disabled={!exportPanel.pivot}
              title={
                exportPanel.pivot
                  ? undefined
                  : "Configure the pivot workspace before exporting it"
              }
              onClick={() => exportPanel.onSelectDataset("pivot")}
            >
              <i>
                <Icon name="grid" size={16} />
              </i>
              <span>
                <strong>
                  Current pivot table <em>CSV · TSV · XLSX</em>
                </strong>
                <small>
                  Uses the pivot’s dimensions, columns, and measure.
                </small>
              </span>
              <b>
                {exportPanel.pivot
                  ? `${formatNumber(exportPanel.pivot.rowKeys.length)} rows × ${formatNumber(Math.max(1, exportPanel.pivot.columnKeys.length))} columns`
                  : "Unavailable"}
              </b>
            </button>
          </div>
          <div className="scope-export-group compact">
            <span>Share and export</span>
            {!scope.isSnapshot && (
              <>
                <button
                  type="button"
                  className="scope-export-option"
                  disabled={!exportPanel.snapshotAvailable}
                  title={
                    exportPanel.snapshotAvailable
                      ? undefined
                      : "Run the production build to export an offline snapshot"
                  }
                  onClick={exportPanel.onSnapshot}
                >
                  <i>
                    <Icon name="spark" size={16} />
                  </i>
                  <span>
                    <strong>
                      Interactive dashboard snapshot <em>HTML</em>
                    </strong>
                    <small>
                      {exportPanel.snapshotAvailable
                        ? "Offline copy of the current view. Contains employee data."
                        : "Available from the production build."}
                    </small>
                  </span>
                </button>
                {exportPanel.snapshotError && (
                  <div className="scope-export-error" role="alert">
                    <span>{exportPanel.snapshotError}</span>
                    <button type="button" onClick={exportPanel.onSnapshot}>
                      Try again
                    </button>
                  </div>
                )}
              </>
            )}
            <button
              type="button"
              className="scope-export-option"
              disabled={exportPanel.userCount === 0}
              onClick={() => exportPanel.onSelectDataset("emails")}
            >
              <i>
                <Icon name="users" size={16} />
              </i>
              <span>
                <strong>
                  Export user email addresses <em>CSV · TSV · XLSX</em>
                </strong>
                <small>
                  {exportPanel.userCount
                    ? "One unique address per row with a stable email header."
                    : "No user email addresses match the current scope."}
                </small>
              </span>
              <b>{formatNumber(exportPanel.userCount)} emails</b>
            </button>
          </div>
          <div className="scope-export-privacy">
            Employee usage data · Share only with authorized recipients
          </div>
        </div>
      )}
    </div>
  );
}
