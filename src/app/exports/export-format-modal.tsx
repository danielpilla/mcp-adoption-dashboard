import { useEffect, useState } from "react";
import { formatNumber } from "../analytics/activity-metrics";
import { Icon } from "../interface/icon";
import type { TabularExportFormat } from "./dashboard-export";
import { useDialogFocusTrap } from "../interface/dialog-focus-trap";

const FORMATS: Array<{
  value: TabularExportFormat;
  label: string;
  note: string;
  badge?: string;
}> = [
  {
    value: "xlsx",
    label: "Excel workbook",
    note: "Workbook with data, filters, and export details.",
    badge: "Recommended",
  },
  {
    value: "csv",
    label: "CSV",
    note: "Comma-separated text for spreadsheets and data tools.",
  },
  {
    value: "tsv",
    label: "TSV",
    note: "Tab-separated text for values that contain commas.",
  },
];

export function ExportFormatModal({
  title,
  description,
  rowCount,
  grain,
  onClose,
  onDownload,
}: {
  title: string;
  description: string;
  rowCount: number;
  grain: string;
  onClose: () => void;
  onDownload: (format: TabularExportFormat) => Promise<void>;
}) {
  const [format, setFormat] = useState<TabularExportFormat>("xlsx");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useDialogFocusTrap<HTMLElement>(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !downloading) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [downloading, onClose]);

  const download = async () => {
    setDownloading(true);
    setError("");
    try {
      await onDownload(format);
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Could not create the download.",
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="export-format-layer">
      <button
        type="button"
        className="export-format-scrim"
        onClick={onClose}
        disabled={downloading}
        tabIndex={-1}
        aria-label="Close format picker"
      />
      <section
        ref={dialogRef}
        className="export-format-modal"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-busy={downloading}
        aria-labelledby="export-format-title"
      >
        <div className="export-format-header">
          <div>
            <span className="eyebrow">Download data</span>
            <h2 id="export-format-title">{title}</h2>
            <p>{description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={downloading}
            aria-label="Close format picker"
            data-dialog-initial-focus
          >
            <Icon name="close" size={17} />
          </button>
        </div>

        <div className="export-format-context">
          <span>{formatNumber(rowCount)} exported rows</span>
          <span>{grain}</span>
          <span>Export details included</span>
        </div>

        <fieldset className="export-format-grid">
          <legend>Choose a format</legend>
          {FORMATS.map((option) => (
            <label
              className={`export-format-card ${
                format === option.value ? "selected" : ""
              }`}
              key={option.value}
            >
              <input
                type="radio"
                name="export-format"
                value={option.value}
                checked={format === option.value}
                disabled={downloading}
                onChange={() => {
                  setFormat(option.value);
                  setError("");
                }}
              />
              <span className="export-format-icon">
                <Icon
                  name={option.value === "xlsx" ? "grid" : "activity"}
                  size={18}
                />
              </span>
              <span>
                <strong>
                  {option.label}
                  {option.badge && <mark>{option.badge}</mark>}
                </strong>
                <small>{option.note}</small>
              </span>
              <b>.{option.value}</b>
            </label>
          ))}
        </fieldset>

        {error && (
          <div className="export-format-error setup-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void download()}>
              Try again
            </button>
          </div>
        )}

        <div className="export-format-footer">
          <span>Employee usage data · Handle appropriately</span>
          <div>
            <button type="button" onClick={onClose} disabled={downloading}>
              Cancel
            </button>
            <button
              type="button"
              className="export-format-download"
              onClick={() => void download()}
              disabled={downloading}
            >
              {downloading ? (
                <span className="spinner" />
              ) : (
                <Icon name="download" size={15} />
              )}
              {downloading
                ? "Preparing…"
                : error
                  ? `Retry ${format.toUpperCase()}`
                  : `Download ${format.toUpperCase()}`}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
