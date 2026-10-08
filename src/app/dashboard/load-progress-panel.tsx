import { useEffect, useState } from "react";
import { formatIsoDate } from "./dashboard-dates";
import type {
  ActivityLoadProgress,
  DashboardLoadProgress,
} from "./dashboard-stream";
import {
  describeDirectoryProgress,
  directoryProgressRatio,
} from "./directory-progress";
import {
  describeLoadState,
  estimateRemainingMs,
  fetchedDayEquivalent,
  formatCountValue,
  formatElapsed,
  formatEstimate,
  loadedRatio,
  retryRemainingMs,
  type LoadState,
} from "./load-progress";

const TICK_MS = 1_000;

function shortDate(value: string): string {
  return formatIsoDate(value, { month: "short", day: "numeric" });
}

/** Re-renders every second so elapsed time and countdowns stay live. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function windowLine(activity: ActivityLoadProgress): string {
  const [current, ...others] = activity.windows;
  if (!current) {
    if (activity.state === "ready") return "All days loaded";
    if (activity.state === "reused") return "Reusing the latest result";
    if (activity.totalWindows === 0) return "Reading cached days";
    return activity.completedWindows >= activity.totalWindows
      ? "Preparing the dashboard"
      : "Starting the next window";
  }
  const pages =
    current.totalPages && current.totalPages > 1
      ? ` · page ${Math.min(current.pagesLoaded + 1, current.totalPages)} of ${current.totalPages}`
      : "";
  const more = others.length > 0 ? ` · +${others.length} more in parallel` : "";
  return `Fetching ${shortDate(current.startDate)} – ${shortDate(current.endDate)}${pages}${more}`;
}

function stateNotice(
  state: LoadState,
  activity: ActivityLoadProgress | undefined,
  sinceEventMs: number,
): { tone: "warn" | "info"; title: string; body: string } | null {
  if (state === "retrying" && activity?.retry) {
    const seconds = Math.ceil(retryRemainingMs(activity, sinceEventMs) / 1_000);
    const reason =
      activity.retry.reason === "rate_limited"
        ? "Cursor asked for a short pause (rate limit)."
        : activity.retry.reason === "server_error"
          ? `Cursor returned ${activity.retry.status ?? "an error"}.`
          : "The connection to Cursor dropped.";
    return {
      tone: "warn",
      title: seconds > 0 ? `Retrying in ${seconds}s` : "Retrying now",
      body: `${reason} Attempt ${activity.retry.attempt} of ${activity.retry.maxAttempts}; loaded days are kept.`,
    };
  }
  if (state === "slow" && activity) {
    const current = activity.windows[0];
    return {
      tone: "info",
      title: "Cursor is responding slowly",
      body: `No new page for ${formatElapsed(activity.idleMs + sinceEventMs)}${
        current
          ? ` while fetching ${shortDate(current.startDate)} – ${shortDate(current.endDate)}`
          : ""
      }. The load is still running.`,
    };
  }
  if (state === "quiet") {
    return {
      tone: "info",
      title: "Waiting for the local server",
      body: `No update for ${formatElapsed(sinceEventMs)}. The request is still open.`,
    };
  }
  return null;
}

export function LoadProgressPanel({
  progress,
  variant = "full",
  showDirectory = true,
  showTitle = true,
}: {
  progress: DashboardLoadProgress;
  variant?: "full" | "compact";
  showDirectory?: boolean;
  /** Hide the title when the surrounding surface already names the load. */
  showTitle?: boolean;
}) {
  const activity = progress.activity;
  const settled = activity?.state === "ready";
  const now = useNow(!settled);
  const sinceEventMs = Math.max(0, now - (progress.receivedAt ?? now));
  const state = describeLoadState(activity, sinceEventMs);
  const notice = stateNotice(state, activity, sinceEventMs);

  const ratio = activity
    ? loadedRatio(activity)
    : progress.completed / Math.max(progress.total, 1);
  const percent = Math.floor(ratio * 100);
  const totalDays = Math.max(activity?.totalDays ?? 0, 1);
  const cachedShare = activity ? activity.cachedDays / totalDays : 0;
  const fetchedShare = activity
    ? (activity.state === "loading"
        ? activity.fetchedDays
        : activity.totalDays - activity.cachedDays) / totalDays
    : ratio;
  // Running windows show their page progress as a lighter segment.
  const inFlightShare =
    activity && activity.state === "loading"
      ? Math.max(0, fetchedDayEquivalent(activity) - activity.fetchedDays) /
        totalDays
      : 0;
  const loadedDays = activity
    ? Math.min(
        activity.totalDays,
        activity.cachedDays +
          (activity.state === "loading"
            ? activity.fetchedDays
            : activity.totalDays - activity.cachedDays),
      )
    : 0;
  const toGo = activity ? activity.totalDays - loadedDays : 0;
  const elapsedMs = activity
    ? activity.elapsedMs + (settled ? 0 : sinceEventMs)
    : 0;
  const estimate = activity ? estimateRemainingMs(activity) : null;
  const remainingMs =
    estimate === null ? null : Math.max(0, estimate - sinceEventMs);
  const title =
    activity?.state === "ready"
      ? "Activity loaded"
      : activity?.state === "reused"
        ? "Using the latest result"
        : activity
          ? "MCP activity"
          : progress.label;
  const subtitle = activity ? windowLine(activity) : progress.detail;
  // Announced in 10% steps and on state changes so readers are not flooded.
  const stateLabel =
    state === "retrying"
      ? ". Retrying a request"
      : notice
        ? `. ${notice.title}`
        : "";
  const announcement = `${title}: ${Math.floor(percent / 10) * 10}%${stateLabel}`;

  return (
    <div
      className={`load-progress is-${variant} is-${state}`}
      data-state={state}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="load-progress-heading">
        <div>
          {showTitle && <strong>{title}</strong>}
          <small>{subtitle}</small>
        </div>
        <b aria-hidden="true">
          {percent}
          <span>%</span>
        </b>
      </div>
      <div
        className="load-progress-track"
        role="progressbar"
        aria-label="Activity loaded"
        aria-valuemin={0}
        aria-valuemax={activity ? activity.totalDays : progress.total}
        aria-valuenow={activity ? loadedDays : progress.completed}
        aria-valuetext={
          activity
            ? `${formatCountValue(loadedDays)} of ${formatCountValue(activity.totalDays)} days loaded`
            : `${percent}%`
        }
      >
        <i
          className="load-progress-cached"
          style={{ width: `${cachedShare * 100}%` }}
        />
        <i
          className="load-progress-fetched"
          style={{ width: `${Math.max(0, fetchedShare) * 100}%` }}
        />
        <i
          className="load-progress-inflight"
          style={{ width: `${inFlightShare * 100}%` }}
        />
      </div>
      <ul className="load-progress-legend" aria-label="Days">
        <li className="is-cached">
          <i aria-hidden="true" />
          {activity ? formatCountValue(activity.cachedDays) : "—"} from cache
        </li>
        <li className="is-fetched">
          <i aria-hidden="true" />
          {activity
            ? formatCountValue(loadedDays - activity.cachedDays)
            : "—"}{" "}
          fetched
        </li>
        <li className="is-pending">
          <i aria-hidden="true" />
          {activity ? formatCountValue(toGo) : "—"} to go
        </li>
      </ul>
      <dl className="load-progress-stats">
        <div>
          <dt>Days</dt>
          <dd>
            {activity ? formatCountValue(loadedDays) : "—"}
            {activity && (
              <small> / {formatCountValue(activity.totalDays)}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>Rows</dt>
          <dd>{activity ? formatCountValue(activity.records) : "—"}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{activity ? formatElapsed(elapsedMs) : "—"}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd className={remainingMs === null || !activity ? "is-muted" : ""}>
            {!activity
              ? "Estimating…"
              : settled || activity.state === "reused"
                ? "Done"
                : remainingMs === null
                  ? "Estimating…"
                  : formatEstimate(remainingMs)}
          </dd>
        </div>
      </dl>
      <div className="load-progress-notice-slot">
        {notice && (
          <div className={`load-progress-notice is-${notice.tone}`}>
            <span className="load-progress-pulse" aria-hidden="true" />
            <div>
              <strong>{notice.title}</strong>
              <small>{notice.body}</small>
            </div>
          </div>
        )}
      </div>
      {showDirectory &&
        progress.directory &&
        progress.directory.status !== "disabled" && (
          <div className="setup-directory-progress">
            <div>
              <strong>Directory groups</strong>
              <small>
                {describeDirectoryProgress(progress.directory)}
                {progress.directory.status === "loading" &&
                  " · loads in the background; the dashboard opens without waiting"}
              </small>
            </div>
            {directoryProgressRatio(progress.directory) !== null && (
              <b>
                {Math.round(
                  (directoryProgressRatio(progress.directory) ?? 0) * 100,
                )}
                %
              </b>
            )}
          </div>
        )}
    </div>
  );
}
