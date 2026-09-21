import type { ReactNode, RefObject } from "react";
import type {
  DateRange,
  McpRecord,
  McpResponse,
} from "../../contracts/mcp-response";
import { presetRange, rangeLabel } from "./dashboard-dates";
import { GlobalSearch, type SearchSelection } from "../scope/global-search";
import { Icon } from "../interface/icon";
import type { DashboardPhase } from "../scope/scope-contract";

interface HeaderStatus {
  data: McpResponse | null;
  isSnapshot: boolean;
  refreshedAt: string;
  busy: boolean;
}

interface RangeControls {
  active: DateRange;
  draft: DateRange;
  startDateInputRef: RefObject<HTMLInputElement | null>;
  onUpdate: (range: DateRange) => void;
}

interface SearchControls {
  records: McpRecord[];
  value: string;
  filtering: boolean;
  onChange: (query: string) => void;
  onSelect: (selection: SearchSelection) => void;
}

interface HeaderActions {
  onOpenSettings: () => void;
  onRefresh: () => void;
}

export function DashboardHeader({
  activePhase,
  status,
  range,
  search,
  actions,
  children,
}: {
  activePhase: DashboardPhase;
  status: HeaderStatus;
  range: RangeControls;
  search: SearchControls;
  actions: HeaderActions;
  children: ReactNode;
}) {
  const { data, isSnapshot, refreshedAt, busy } = status;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="network" size={22} />
          </span>
          <span className="brand-divider" />
          <div>
            <strong>Cursor MCP Adoption</strong>
            <span>{data?.team?.name ?? "MCP usage dashboard"}</span>
          </div>
        </div>
        <div className="topbar-actions">
          {data && (
            <span
              className="last-refreshed"
              title={new Date(data.generatedAt).toLocaleString()}
            >
              <small>
                {isSnapshot ? "Snapshot generated" : "Last refreshed"}
              </small>
              <strong>{refreshedAt}</strong>
            </span>
          )}
          {!isSnapshot && (
            <>
              <button
                className="topbar-button settings-button"
                type="button"
                onClick={actions.onOpenSettings}
              >
                <Icon name="tools" size={15} />
                Settings
              </button>
              <button
                className="topbar-button"
                type="button"
                onClick={actions.onRefresh}
                disabled={!data || busy}
              >
                {busy ? (
                  <span className="spinner" />
                ) : (
                  <Icon name="refresh" size={15} />
                )}
                Refresh
              </button>
            </>
          )}
        </div>
      </header>

      <main
        id="dashboard-content"
        tabIndex={-1}
        className={`mode-${activePhase.replace("-phase", "")}`}
      >
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow hero-eyebrow">
              <Icon name="spark" size={14} />
              {data?.team
                ? `${data.team.name} · ${data.team.memberCount} members · ${data.team.groupCount} groups`
                : "Team MCP activity"}
            </span>
            <h1>
              MCP ADOPTION
              <br />
              <em>ANALYTICS</em>
            </h1>
            <p>
              See who is using MCP, which servers and tools they use, and how
              activity changes over time.
            </p>
          </div>
          <div className="hero-orbit" aria-hidden="true">
            <div className="orbit-ring ring-one" />
            <div className="orbit-ring ring-two" />
            <div className="orbit-core">
              <Icon name="network" size={30} />
            </div>
            <span className="orbit-node node-one" />
            <span className="orbit-node node-two" />
            <span className="orbit-node node-three" />
          </div>
        </section>

        <section className="control-deck">
          <div className="date-control">
            <div className="control-label">
              <Icon name="calendar" size={16} />
              <span>Analysis window</span>
            </div>
            {!isSnapshot ? (
              <>
                <div className="preset-group">
                  {[7, 30, 90].map((days) => {
                    const preset = presetRange(days);
                    const active =
                      range.draft.startDate === preset.startDate &&
                      range.draft.endDate === preset.endDate;
                    return (
                      <button
                        key={days}
                        type="button"
                        className={active ? "active" : ""}
                        aria-pressed={active}
                        onClick={() => range.onUpdate(preset)}
                      >
                        {days}D
                      </button>
                    );
                  })}
                </div>
                <div className="custom-dates">
                  <input
                    ref={range.startDateInputRef}
                    type="date"
                    value={range.draft.startDate}
                    max={range.draft.endDate}
                    onChange={(event) =>
                      range.onUpdate({
                        ...range.draft,
                        startDate: event.target.value,
                      })
                    }
                    aria-label="Start date"
                  />
                  <span>to</span>
                  <input
                    type="date"
                    value={range.draft.endDate}
                    min={range.draft.startDate}
                    onChange={(event) =>
                      range.onUpdate({
                        ...range.draft,
                        endDate: event.target.value,
                      })
                    }
                    aria-label="End date"
                  />
                </div>
              </>
            ) : (
              <strong className="snapshot-range">
                {rangeLabel(range.active.startDate, range.active.endDate)}
              </strong>
            )}
          </div>
          <div className="filter-controls">
            <GlobalSearch
              shortcutEnabled
              records={search.records}
              value={search.value}
              onChange={search.onChange}
              onSelect={search.onSelect}
            />
            {search.filtering && (
              <span className="filtering-indicator" role="status">
                <span className="spinner" /> Updating view
              </span>
            )}
          </div>
        </section>

        {children}
      </main>
    </>
  );
}
