import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { McpResponse } from "../../contracts/mcp-response";
import { App } from "../dashboard/dashboard-application";
import { presetRange } from "../dashboard/dashboard-dates";
import {
  DashboardSetupRequiredError,
  readDashboardStream,
  type DashboardLoadProgress,
} from "../dashboard/dashboard-stream";
import {
  optionalString,
  readJsonObject,
} from "../dashboard/dashboard-api-client";
import { Icon } from "../interface/icon";
import { useDialogFocusTrap } from "../interface/dialog-focus-trap";

type SetupStatus = {
  configured: boolean;
  setupAllowed: boolean;
};

type SetupView =
  | "checking"
  | "loading"
  | "revealing"
  | "configured"
  | "required"
  | "blocked"
  | "error";

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
  const [loadProgress, setLoadProgress] = useState<DashboardLoadProgress>({
    completed: 0,
    total: 1,
    label: "Starting",
    detail: "Connecting to Cursor",
  });
  const checkedStatus = useRef(false);
  const setupDialogRef = useDialogFocusTrap<HTMLElement>(
    view !== "configured",
    view,
  );

  const loadDashboard = useCallback(async () => {
    setView("loading");
    setError("");
    setLoadProgress({
      completed: 0,
      total: 1,
      label: "Starting",
      detail: "Connecting to Cursor",
    });
    try {
      const range = presetRange(90);
      const query = new URLSearchParams({
        startDate: range.startDate,
        endDate: range.endDate,
      });
      const response = await fetch(`/api/mcp/stream?${query}`, {
        cache: "no-store",
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
      const loadedData = await readDashboardStream(
        response.body,
        setLoadProgress,
      );

      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      if (!reduceMotion) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      setDashboardData(loadedData);
      setView("revealing");
      if (!reduceMotion) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      }
      setView("configured");
    } catch (loadError) {
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
    }
  }, []);

  const checkStatus = useCallback(async () => {
    if (initialData) return;
    setView("checking");
    setError("");
    try {
      const response = await fetch("/api/setup/status", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not reach the local server.");
      const body = await readJsonObject(response, "setup status");
      if (
        typeof body.configured !== "boolean" ||
        typeof body.setupAllowed !== "boolean"
      ) {
        throw new Error("The local server returned invalid setup status.");
      }
      const status: SetupStatus = {
        configured: body.configured,
        setupAllowed: body.setupAllowed,
      };
      if (status.configured) {
        await loadDashboard();
      } else {
        setView(status.setupAllowed ? "required" : "blocked");
      }
    } catch (statusError) {
      setError(
        statusError instanceof Error
          ? statusError.message
          : "Could not check dashboard setup.",
      );
      setView("error");
    }
  }, [initialData, loadDashboard]);

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
      await loadDashboard();
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

  return (
    <>
      {(view === "configured" || view === "revealing") && dashboardData && (
        <div>
          <App initialData={dashboardData} onSetupRequired={requireSetup} />
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
            className="setup-modal"
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
            </div>

            <div className="setup-modal-copy">
              <span className="eyebrow">
                {view === "loading" || view === "revealing"
                  ? "90-day view"
                  : "Local setup"}
              </span>
              <h1 id="setup-title">
                {view === "blocked"
                  ? "Finish setup from the server"
                  : view === "error"
                    ? "Dashboard couldn’t load"
                    : view === "loading" || view === "revealing"
                      ? "Loading dashboard"
                      : "Connect Cursor"}
              </h1>
              {view !== "loading" && view !== "revealing" && (
                <p>
                  {view === "blocked"
                    ? "Browser setup is disabled when the dashboard is exposed beyond loopback."
                    : view === "error"
                      ? error ||
                        "The dashboard could not load its initial data."
                      : "Enter a Team Admin API key. It will be validated and stored in .env on this machine."}
                </p>
              )}
            </div>

            {view === "required" && (
              <form
                className="setup-form"
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

            {(view === "loading" || view === "revealing") && (
              <div
                className="setup-load-progress"
                role="status"
                aria-live="polite"
              >
                <div className="setup-load-progress-heading">
                  <div>
                    <strong>{loadProgress.label}</strong>
                    <small>{loadProgress.detail}</small>
                  </div>
                  <b>
                    {Math.round(
                      (loadProgress.completed /
                        Math.max(loadProgress.total, 1)) *
                        100,
                    )}
                    %
                  </b>
                </div>
                <div
                  className="setup-load-progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={loadProgress.total}
                  aria-valuenow={loadProgress.completed}
                >
                  <i
                    style={{
                      width: `${(loadProgress.completed / Math.max(loadProgress.total, 1)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {(view === "blocked" || view === "error") && (
              <div className="setup-recovery">
                <code>npm run init</code>
                {view === "error" && (
                  <button type="button" onClick={() => void checkStatus()}>
                    Try again
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
