import { useEffect, useState, type FormEvent } from "react";
import {
  optionalString,
  readJsonObject,
} from "../dashboard/dashboard-api-client";
import { Icon } from "../interface/icon";
import { useDialogFocusTrap } from "../interface/dialog-focus-trap";

export function SettingsModal({
  onClose,
  onRotated,
}: {
  onClose: () => void;
  onRotated: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [rotationAllowed, setRotationAllowed] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [statusRequest, setStatusRequest] = useState(0);
  const dialogRef = useDialogFocusTrap<HTMLElement>(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    const controller = new AbortController();
    setRotationAllowed(null);
    setStatusError("");
    void fetch("/api/setup/status", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load settings.");
        return readJsonObject(response, "settings status");
      })
      .then((status) => {
        if (typeof status.setupAllowed !== "boolean") {
          throw new Error("The local server returned invalid settings status.");
        }
        setRotationAllowed(status.setupAllowed);
      })
      .catch((statusError: unknown) => {
        if (controller.signal.aborted) return;
        setStatusError(
          statusError instanceof Error
            ? statusError.message
            : "Could not load settings.",
        );
      });
    return () => {
      controller.abort();
    };
  }, [statusRequest]);

  const rotate = async (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key || !rotationAllowed) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const body = await readJsonObject(response, "key rotation response");
      if (!response.ok || body.configured !== true) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? "Cursor rejected this key. Confirm it is a Team Admin API key with Analytics access."
            : optionalString(body.error) || "Could not update the API key.",
        );
      }
      setApiKey("");
      onRotated();
    } catch (rotationError) {
      setError(
        rotationError instanceof Error
          ? rotationError.message
          : "Could not update the API key.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-layer">
      <button
        className="settings-scrim"
        type="button"
        onClick={onClose}
        disabled={saving}
        aria-label="Close settings"
      />
      <section
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="settings-header">
          <div>
            <span className="eyebrow">Dashboard settings</span>
            <h2 id="settings-title">Connection</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close settings"
            data-dialog-initial-focus
          >
            <Icon name="close" size={17} />
          </button>
        </div>

        <div
          className={`settings-connection-status${statusError ? " error" : ""}`}
        >
          <span>
            <Icon name="server" size={18} />
          </span>
          <div>
            <strong>Cursor Team Admin API</strong>
            <small>
              {rotationAllowed === null
                ? statusError
                  ? "Settings status unavailable"
                  : "Checking settings…"
                : rotationAllowed
                  ? "API key updates are available"
                  : "API key updates are server-only"}
            </small>
          </div>
          <i />
        </div>

        {statusError ? (
          <div className="settings-status-error setup-error" role="alert">
            <span>{statusError}</span>
            <button
              type="button"
              onClick={() => setStatusRequest((request) => request + 1)}
            >
              Try again
            </button>
          </div>
        ) : rotationAllowed === false ? (
          <div className="settings-local-only">
            <Icon name="tools" size={18} />
            <div>
              <strong>Rotate from the server</strong>
              <p>
                This dashboard can only update the key when it runs on the same
                computer. Update the key on the server instead.
              </p>
              <code>npm run init</code>
            </div>
          </div>
        ) : (
          <form
            className="settings-key-form"
            onSubmit={(event) => void rotate(event)}
          >
            <div>
              <label htmlFor="settings-api-key">Replace API key</label>
              <p>
                The existing key is never returned to the browser. Enter a new
                key only when rotating or repairing the connection.
              </p>
            </div>
            <div className="settings-key-input">
              <Icon name="server" size={18} />
              <input
                id="settings-api-key"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste a new Team Admin API key"
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                disabled={rotationAllowed !== true || saving}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowKey((visible) => !visible)}
                disabled={rotationAllowed !== true || saving}
                aria-label={showKey ? "Hide API key" : "Show API key"}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
            <small>
              Checked before replacement · Saved on this computer only
            </small>
            {error && (
              <div className="setup-error" role="alert">
                {error}
              </div>
            )}
            <div className="settings-actions">
              <button type="button" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button
                className="settings-save"
                type="submit"
                disabled={rotationAllowed !== true || !apiKey.trim() || saving}
              >
                {saving ? (
                  <span className="spinner" />
                ) : (
                  <Icon name="refresh" size={15} />
                )}
                {saving ? "Validating…" : "Validate and replace"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
