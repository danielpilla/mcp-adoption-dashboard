import { useId, type CSSProperties } from "react";
import { formatIsoDate, parseIsoDate } from "../dashboard/dashboard-dates";
import type {
  McpMomentumItem,
  McpMomentumPeriod,
  McpMomentumResult,
} from "./mcp-momentum";
import { McpServerLabel } from "../relationships/mcp-server-label";
import { SelectionMark } from "../scope/selection-mark";
import {
  SelectionToolbar,
  type SelectionActionField,
} from "../scope/selection-toolbar";
import type { SelectionField } from "../scope/selection-model";

function formatDate(value: string): string {
  return formatIsoDate(value, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatPeriod(period: McpMomentumPeriod): string {
  const start = parseIsoDate(period.startDate);
  const end = parseIsoDate(period.endDate);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const startLabel = formatIsoDate(period.startDate, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
  const endLabel = formatIsoDate(period.endDate, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startLabel}–${endLabel}`;
}

function formatSigned(value: number): string {
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toLocaleString()}`;
}

function formatPercentage(value: number, compact: boolean): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const magnitude = Math.abs(value);
  if (magnitude > 0 && magnitude < 0.1) return `${sign}<0.1%`;
  const formatted = new Intl.NumberFormat("en-US", {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(magnitude);
  return `${sign}${formatted}%`;
}

function changeLabel(item: McpMomentumItem, compact = false): string {
  if (item.status === "new") {
    return `No prior-period calls · ${formatSigned(item.change)}`;
  }
  if (item.status === "inactive") {
    return `No calls in current period · ${formatSigned(item.change)}`;
  }
  return `${formatSigned(item.change)} · ${formatPercentage(
    item.percentageChange,
    compact,
  )}`;
}

function MomentumLane({
  direction,
  headingId,
  items,
  selectedServers,
  onToggleServer,
}: {
  direction: "increased" | "decreased";
  headingId: string;
  items: McpMomentumItem[];
  selectedServers: string[];
  onToggleServer: (server: string) => void;
}) {
  const visibleItems = items.slice(0, 5);
  const maxChange = Math.max(
    ...visibleItems.map((item) => Math.abs(item.change)),
    1,
  );
  const increased = direction === "increased";

  return (
    <section
      className={`momentum-lane ${direction}`}
      aria-labelledby={headingId}
    >
      <div className="momentum-lane-heading">
        <span className="momentum-direction" aria-hidden="true">
          {increased ? "↑" : "↓"}
        </span>
        <div>
          <h3 id={headingId}>
            {increased ? "Increased activity" : "Decreased activity"}
          </h3>
          <span>
            {visibleItems.length < items.length
              ? `Top ${visibleItems.length} of ${items.length}`
              : items.length}{" "}
            MCP{items.length === 1 ? "" : "s"}
          </span>
        </div>
        <span className="momentum-period-key">Earlier → Current</span>
      </div>
      {visibleItems.length > 0 ? (
        <ol className="momentum-list">
          {visibleItems.map((item, index) => {
            const selected = selectedServers.includes(item.server);
            const label = changeLabel(item, true);
            const accessibleChange = changeLabel(item);
            return (
              <li key={item.server}>
                <button
                  type="button"
                  className={`momentum-row chart-selectable${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  aria-label={`${selected ? "Remove" : "Add"} ${item.server} MCP filter. Earlier period ${item.previousCalls.toLocaleString()} calls. Current period ${item.currentCalls.toLocaleString()} calls. ${accessibleChange}.`}
                  title={item.server}
                  onClick={() => onToggleServer(item.server)}
                >
                  <span className="momentum-rank" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="momentum-identity">
                    <McpServerLabel server={item.server} />
                    <span className="momentum-rail" aria-hidden="true">
                      <i
                        style={
                          {
                            "--momentum-width": `${(Math.abs(item.change) / maxChange) * 100}%`,
                          } as CSSProperties
                        }
                      />
                    </span>
                  </span>
                  <span className="momentum-values">
                    <strong>
                      {item.previousCalls.toLocaleString()}
                      <span aria-hidden="true"> → </span>
                      <span className="sr-only"> to </span>
                      {item.currentCalls.toLocaleString()}
                    </strong>
                    <small>{label}</small>
                  </span>
                  <SelectionMark selected={selected} />
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="momentum-lane-empty">
          No MCPs {increased ? "increased" : "decreased"} in this comparison.
        </p>
      )}
    </section>
  );
}

export function McpMomentumPanel({
  result,
  selectedServers,
  onToggleServer,
  selectionActive,
  pendingChangeCount,
  onApplySelection,
  onCancelSelection,
  selectionFields,
  onSelectValues,
}: {
  result: McpMomentumResult;
  selectedServers: string[];
  onToggleServer: (server: string) => void;
  selectionActive: boolean;
  pendingChangeCount: number;
  onApplySelection: () => void;
  onCancelSelection: () => void;
  selectionFields: SelectionActionField[];
  onSelectValues: (field: SelectionField, values: string[]) => void;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const ready = result.status === "ready";
  const subtitle = ready
    ? `Earlier ${formatPeriod(result.previousPeriod)} → Current ${formatPeriod(result.currentPeriod)} · Ranked by absolute call change`
    : "Compare equal periods within a continuous date selection.";

  return (
    <section
      className={`panel momentum-panel${selectedServers.length > 0 ? " has-selection" : ""}`}
      aria-labelledby={titleId}
    >
      <div className="panel-heading momentum-heading">
        <div>
          <span className="eyebrow">Period comparison</span>
          <h2 id={titleId}>MCP momentum</h2>
          <p>{subtitle}</p>
        </div>
        <SelectionToolbar
          active={selectionActive}
          count={pendingChangeCount}
          onApply={onApplySelection}
          onCancel={onCancelSelection}
          fields={selectionFields}
          onSelectValues={onSelectValues}
        />
      </div>

      {ready ? (
        <>
          <div className="momentum-lanes">
            <MomentumLane
              direction="increased"
              headingId={`${id}-increased-heading`}
              items={result.increased}
              selectedServers={selectedServers}
              onToggleServer={onToggleServer}
            />
            <MomentumLane
              direction="decreased"
              headingId={`${id}-decreased-heading`}
              items={result.decreased}
              selectedServers={selectedServers}
              onToggleServer={onToggleServer}
            />
          </div>
          <div className="momentum-footer">
            <span>
              {result.unchangedCount.toLocaleString()} MCP
              {result.unchangedCount === 1 ? "" : "s"} unchanged
            </span>
            {result.omittedLeadingDate && (
              <span>
                {formatDate(result.omittedLeadingDate)} excluded to keep periods
                equal
              </span>
            )}
          </div>
        </>
      ) : (
        <div
          className="momentum-state"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <strong>
            {result.status === "disjoint-range"
              ? "Choose a continuous time span"
              : "More history is needed"}
          </strong>
          <p>
            {result.status === "disjoint-range"
              ? "MCP momentum cannot compare sparse or disjoint date selections. Clear granular time filters or choose one continuous range."
              : `At least 6 complete days are needed to compare momentum. This scope has ${result.availableDays}.`}
          </p>
        </div>
      )}
    </section>
  );
}
