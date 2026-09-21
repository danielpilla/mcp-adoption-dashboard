import type { CSSProperties } from "react";
import type { McpSummary } from "../../contracts/mcp-response";
import { formatNumber } from "../analytics/activity-metrics";
import { DashboardPhaseHeader } from "./dashboard-phase-header";
import { Icon } from "../interface/icon";
import type { KpiType } from "../analytics/kpi-drawer";
import { McpServerLabel } from "../relationships/mcp-server-label";

export interface DashboardKpiView {
  type: KpiType;
  label: string;
  value: number;
  icon: "activity" | "users" | "server" | "tools";
  note: string;
  delta: string;
  deltaTone: "positive" | "negative" | "neutral";
}

interface OverviewScope {
  originLocked: boolean;
  originLabel: string;
  evidenceThrough: string;
  evidenceIncludesToday: boolean;
}

interface LeadingServer {
  server: string;
  usage: number;
  users: number;
}

interface OverviewActions {
  onSelectKpi: (type: KpiType) => void;
  onSelectServer: (server: string) => void;
}

export function DashboardOverview({
  scope,
  kpis,
  summary,
  leadingServer,
  actions,
}: {
  scope: OverviewScope;
  kpis: DashboardKpiView[];
  summary: McpSummary;
  leadingServer?: LeadingServer;
  actions: OverviewActions;
}) {
  return (
    <>
      <DashboardPhaseHeader
        id="dashboard-phase"
        number="01"
        label="Dashboard"
        question="What is happening?"
      />

      <div className="scope-context" aria-label="Metric scope and freshness">
        <strong>
          <Icon name={scope.originLocked ? "lock" : "filter"} size={13} />
          {scope.originLabel}
        </strong>
        <span>
          Metrics reflect observed calls, not currently configured connections.
        </span>
        <span>
          Evidence through {scope.evidenceThrough}
          {scope.evidenceIncludesToday ? " · today may be incomplete" : ""}
        </span>
      </div>

      <section className="kpi-grid" aria-label="MCP adoption summary">
        {kpis.map((kpi, index) => (
          <button
            type="button"
            className="kpi-card"
            key={kpi.label}
            style={{ "--delay": `${index * 60}ms` } as CSSProperties}
            onClick={() => actions.onSelectKpi(kpi.type)}
            aria-label={`Explore ${kpi.label}: ${formatNumber(kpi.value)}. ${kpi.delta}. ${kpi.note}`}
          >
            <span className="kpi-icon">
              <Icon name={kpi.icon} />
            </span>
            <div className="kpi-value">{formatNumber(kpi.value)}</div>
            <div className="kpi-label">{kpi.label}</div>
            <div className={`kpi-delta ${kpi.deltaTone}`}>{kpi.delta}</div>
            <div className="kpi-note">
              <span />
              {kpi.note}
              <Icon name="chevron" size={13} />
            </div>
          </button>
        ))}
      </section>
      {leadingServer && (
        <section className="insight-strip" aria-label="Key adoption insight">
          <span className="insight-mark">
            <Icon name="spark" size={17} />
          </span>
          <div>
            <span className="eyebrow">Signal from this period</span>
            <p>
              <strong>
                <McpServerLabel server={leadingServer.server} />
              </strong>{" "}
              is the leading MCP by observed calls in this scope, driving{" "}
              <strong>
                {Math.round(
                  (leadingServer.usage / Math.max(summary.totalUsage, 1)) * 100,
                )}
                %
              </strong>{" "}
              of observed calls across{" "}
              <strong>{leadingServer.users} active users</strong>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => actions.onSelectServer(leadingServer.server)}
          >
            View MCP details <Icon name="chevron" size={15} />
          </button>
        </section>
      )}
    </>
  );
}
