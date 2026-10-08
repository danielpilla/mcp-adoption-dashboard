import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { McpResponse } from "../../contracts/mcp-response";
import {
  parseCacheCoverage,
  parseStartupRange,
  type CacheCoverage,
  type StartupRange,
} from "../../contracts/startup-range";
import { App } from "../dashboard/dashboard-application";
import { DEFAULT_RANGE_DAYS } from "../../contracts/date-range-days";
import {
  inclusiveDayCount,
  initialRangeDays,
  isoDate,
  rangeLabel,
} from "../dashboard/dashboard-dates";
import {
  DashboardSetupRequiredError,
  readDashboardStream,
  type DashboardLoadProgress,
} from "../dashboard/dashboard-stream";
import {
  optionalString,
  readJsonObject,
} from "../dashboard/dashboard-api-client";
import { LoadProgressPanel } from "../dashboard/load-progress-panel";
import { Icon } from "../interface/icon";
import { useDialogFocusTrap } from "../interface/dialog-focus-trap";
import {
  planStartup,
  readLocalStartupRange,
  resolveStartupRange,
  saveStartupRange,
} from "./range-choice";
import { RangeStep } from "./range-step";

type SetupStatus = {
  configured: boolean;
  setupAllowed: boolean;
  defaultRangeDays: number;
  rangePreference: StartupRange | null;
  cacheCoverage: CacheCoverage | null;
};

type SetupView =
  | "checking"
  | "choose-range"
  | "loading"
  | "revealing"
  | "configured"
  | "required"
  | "blocked"
  | "error";

const STARTING_PROGRESS: DashboardLoadProgress = {
  completed: 0,
  total: 1,
  label: "Starting",
  detail: "Connecting to Cursor",
};

function todayIso(): string {
  return isoDate(new Date());
}

function readSetupStatus(body: Record<string, unknown>): SetupStatus {
  if (
    typeof body.configured !== "boolean" ||
    typeof body.setupAllowed !== "boolean"
  ) {
    throw new Error("The local server returned invalid setup status.");
  }
  return {
    configured: body.configured,
    setupAllowed: body.setupAllowed,
    defaultRangeDays: initialRangeDays(body.defaultRangeDays),
    // Servers without stored preferences fall back to this browser's copy.
    rangePreference:
      parseStartupRange(body.rangePreference) ?? readLocalStartupRange(),
    cacheCoverage: parseCacheCoverage(body.cacheCoverage),
  };
}

export function SetupGate({
  initialData,
}: {
  initialData: McpResponse | null;
}) {
  const [view, setView] = useState<SetupView>(
    initialData ? "configured" : "checking",
  );
  const [dashboardData, setDashboardData] = useState(initialData);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [selection, setSelection] = useState<StartupRange>({
    kind: "preset",
    days: DEFAULT_RANGE_DAYS,
  });
  const [loadProgress, setLoadProgress] =
    useState<DashboardLoadProgress>(STARTING_PROGRESS);
  const checkedStatus = useRef(false);
  const loadController = useRef<AbortController | null>(null);
  const setupDialogRef = useDialogFocusTrap<HTMLElement>(
    view !== "configured",
    view,
  );

  const loadDashboard = useCallback(async (range: StartupRange) => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setSelection(range);
    setView("loading");
    setError("");
    setLoadProgress({ ...STARTING_PROGRESS, receivedAt: Date.now() });
    try {
      const dates = resolveStartupRange(range, todayIso());
      const query = new URLSearchParams({
        startDate: dates.startDate,
        endDate: dates.endDate,
      });
      const response = await fetch(`/api/mcp/stream?${query}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await readJsonObject(response, "error response");
        const responseError = optionalString(body.error);
        if (response.status === 428 && body.code === "SETUP_REQUIRED") {
          setDashboardData(null);
          setError(
            responseError ||
              "The saved Cursor API key is no longer valid. Enter a new key to reconnect.",
          );
          setView("required");
          return;
        }
        throw new Error(responseError || "Could not load MCP analytics.");
      }
      const loadedData = await readDashboardStream(response.body, (progress) =>
        setLoadProgress({ ...progress, receivedAt: Date.now() }),
      );
      if (controller.signal.aborted) return;

      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      if (!reduceMotion) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      if (controller.signal.aborted) return;
      setDashboardData(loadedData);
      setView("revealing");
      if (!reduceMotion) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      }
      setView("configured");
    } catch (loadError) {
      if (controller.signal.aborted) return;
      if (loadError instanceof DashboardSetupRequiredError) {
        setDashboardData(null);
        setError(
          loadError.message ||
            "The saved Cursor API key is no longer valid. Enter a new key to reconnect.",
        );
        setView("required");
        return;
      }
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load the dashboard.",
      );
      setView("error");
    } finally {
      if (loadController.current === controller) loadController.current = null;
    }
  }, []);

  useEffect(() => () => loadController.current?.abort(), []);

  const startFromStatus = useCallback(
    async (nextStatus: SetupStatus) => {
      setStatus(nextStatus);
      if (!nextStatus.configured) {
        setSelection({ kind: "preset", days: nextStatus.defaultRangeDays });
        setView(nextStatus.setupAllowed ? "required" : "blocked");
        return;
      }
      const plan = planStartup({
        remembered: nextStatus.rangePreference,
        coverage: nextStatus.cacheCoverage,
        defaultRangeDays: nextStatus.defaultRangeDays,
        today: todayIso(),
      });
      setSelection(plan.selection);
      if (plan.autoLoad) {
        await loadDashboard(plan.selection);
      } else {
        setView("choose-range");
      }
    },
    [loadDashboard],
  );

  const fetchStatus = useCallback(async () => {
    const response = await fetch("/api/setup/status", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not reach the local server.");
    return readSetupStatus(await readJsonObject(response, "setup status"));
  }, []);

  const checkStatus = useCallback(async () => {
    if (initialData) return;
    setView("checking");
    setError("");
    try {
      await startFromStatus(await fetchStatus());
    } catch (statusError) {
      setError(
        statusError instanceof Error
          ? statusError.message
          : "Could not check dashboard setup.",
      );
      setView("error");
    }
  }, [fetchStatus, initialData, startFromStatus]);

  useEffect(() => {
    if (checkedStatus.current) return;
    checkedStatus.current = true;
    void checkStatus();
  }, [checkStatus]);

  const requireSetup = useCallback(() => {
    setDashboardData(null);
    setApiKey("");
    setError(
      "The saved Cursor API key is no longer valid. Enter a new key to reconnect.",
    );
    setView("required");
  }, []);

  const chooseRange = useCallback(
    (range: StartupRange) => {
      void saveStartupRange(range);
      setStatus((current) =>
        current ? { ...current, rangePreference: range } : current,
      );
      void loadDashboard(range);
    },
    [loadDashboard],
  );

  const changeRange = useCallback(() => {
    loadController.current?.abort();
    loadController.current = null;
    setError("");
    setView("choose-range");
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const body = await readJsonObject(response, "setup response");
      if (!response.ok || body.configured !== true) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? "Cursor rejected this key. Confirm it is a Team Admin API key with Analytics access."
            : optionalString(body.error) || "Could not save the API key.",
        );
      }
      setApiKey("");
      let nextStatus: SetupStatus;
      try {
        nextStatus = await fetchStatus();
      } catch {
        nextStatus = {
          ...(status ?? {
            setupAllowed: true,
            defaultRangeDays: DEFAULT_RANGE_DAYS,
            rangePreference: readLocalStartupRange(),
            cacheCoverage: null,
          }),
          configured: true,
        };
      }
      await startFromStatus({ ...nextStatus, configured: true });
    } catch (setupError) {
      setError(
        setupError instanceof Error
          ? setupError.message
          : "Could not configure the dashboard.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const today = todayIso();
  const selectedDates = resolveStartupRange(selection, today);
  const rangeDays = inclusiveDayCount(selectedDates);
  const loadingView = view === "loading" || view === "revealing";
  const wide = view === "choose-range" || loadingView;

  return (
    <>
      {(view === "configured" || view === "revealing") && dashboardData && (
        <div>
          <App
            initialData={dashboardData}
            defaultRangeDays={rangeDays}
            onSetupRequired={requireSetup}
          />
        </div>
      )}
      {view !== "configured" && (
        <div
          className={`setup-shell ${
            view === "revealing" ? "is-revealing" : ""
          }`}
        >
          <div className="ambient-glow ambient-one" />
          <div className="ambient-glow ambient-two" />
          <div className="setup-preview" aria-hidden="true">
            <div className="setup-preview-top">
              <span />
              <i />
            </div>
            <div className="setup-preview-hero">
              <i />
              <strong />
              <span />
            </div>
            <div className="setup-preview-grid">
              {[0, 1, 2, 3].map((item) => (
                <span key={item} />
              ))}
            </div>
            <div className="setup-preview-panels">
              <span />
              <span />
            </div>
          </div>
          <div className="setup-scrim" />
          <section
            ref={setupDialogRef}
            className={`setup-modal${wide ? " is-wide" : ""} view-${view}`}
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="setup-title"
          >
            <div className="setup-modal-brand">
              <span className="brand-mark" aria-hidden="true">
                <Icon name="network" size={23} />
              </span>
              <span>Cursor MCP Adoption</span>
              {view === "choose-range" && (
                <span className="setup-modal-step">Startup range</span>
              )}
            </div>

            <div className="setup-modal-copy" key={`copy-${view}`}>
              <span className="eyebrow">
                {loadingView
                  ? `${rangeDays}-day view`
                  : view === "choose-range"
                    ? "Choose what to load"
                    : "Local setup"}
              </span>
              <div className="setup-modal-title-row">
                <h1 id="setup-title">
                  {view === "blocked"
                    ? "Finish setup from the server"
                    : view === "error"
                      ? "Dashboard couldn’t load"
                      : loadingView
                        ? "Loading dashboard"
                        : view === "choose-range"
                          ? "Pick a starting range"
                          : "Connect Cursor"}
                </h1>
                {view === "loading" && (
                  <button
                    type="button"
                    className="setup-change-range"
                    onClick={changeRange}
                  >
                    <Icon name="calendar" size={14} />
                    Change range
                  </button>
                )}
              </div>
              {loadingView ? (
                <p className="setup-range-line">
                  {rangeLabel(selectedDates.startDate, selectedDates.endDate)}
                </p>
              ) : (
                <p>
                  {view === "blocked"
                    ? "Browser setup is disabled when the dashboard is exposed beyond loopback."
                    : view === "error"
                      ? error ||
                        "The dashboard could not load its initial data."
                      : view === "choose-range"
                        ? "Choose how much MCP activity to load first. You can switch ranges any time from the dashboard header."
                        : "Enter a Team Admin API key. It will be validated and stored in .env on this machine."}
                </p>
              )}
            </div>

            {view === "choose-range" && (
              <RangeStep
                initial={selection}
                remembered={status?.rangePreference ?? null}
                coverage={status?.cacheCoverage ?? null}
                today={today}
                onConfirm={chooseRange}
              />
            )}

            {view === "required" && (
              <form
                className="setup-form setup-step"
                onSubmit={(event) => void submit(event)}
              >
                <label htmlFor="setup-api-key">Team Admin API key</label>
                <div className="setup-key-field">
                  <Icon name="server" size={18} />
                  <input
                    id="setup-api-key"
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Paste your Team Admin API key"
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((visible) => !visible)}
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                  >
                    {showKey ? "Hide" : "Show"}
                  </button>
                </div>
                <small>
                  Stored in <code>.env</code> with owner-only permissions.
                </small>
                {error && (
                  <div className="setup-error" role="alert">
                    {error}
                  </div>
                )}
                <button
                  className="setup-submit"
                  type="submit"
                  disabled={!apiKey.trim() || submitting}
                >
                  {submitting ? (
                    <span className="spinner" />
                  ) : (
                    <Icon name="spark" size={17} />
                  )}
                  {submitting ? "Validating access…" : "Connect dashboard"}
                </button>
              </form>
            )}

            {view === "checking" && (
              <div className="setup-checking" role="status">
                <span className="spinner" />
                Checking local configuration…
              </div>
            )}

            {loadingView && (
              <div
                className="setup-load-progress setup-step"
                tabIndex={-1}
                data-dialog-initial-focus
              >
                <LoadProgressPanel progress={loadProgress} />
              </div>
            )}

            {(view === "blocked" || view === "error") && (
              <div className="setup-recovery">
                <code>npm run init</code>
                {view === "error" && (
                  <span className="setup-recovery-actions">
                    {status?.configured && (
                      <button
                        type="button"
                        className="is-quiet"
                        onClick={changeRange}
                      >
                        Change range
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void (status?.configured
                          ? loadDashboard(selection)
                          : checkStatus())
                      }
                    >
                      Try again
                    </button>
                  </span>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
