import { useId, useMemo, useState, type FormEvent } from "react";
import { MAX_DATE_RANGE_DAYS } from "../../contracts/date-range-days";
import type {
  CacheCoverage,
  StartupRange,
} from "../../contracts/startup-range";
import { rangeLabel } from "../dashboard/dashboard-dates";
import { Icon } from "../interface/icon";
import {
  STARTUP_PRESETS,
  checkCustomRange,
  loadEffort,
  rangeCoverage,
  resolveStartupRange,
  sameStartupRange,
  type RangeCoverage,
} from "./range-choice";

const PRESET_CAPTIONS: Record<(typeof STARTUP_PRESETS)[number], string> = {
  7: "Last week",
  30: "Last month",
  90: "Last quarter",
  180: "Last 6 months",
  365: "Last year",
};

const EFFORT_LABELS = [
  "Fastest first load",
  "Quick first load",
  "Moderate first load",
  "Longer first load",
  "Longest first load",
];
const countFormat = new Intl.NumberFormat("en-US");

function CoverageRow({ coverage }: { coverage: RangeCoverage }) {
  if (coverage.status === "full") {
    return (
      <span className="range-card-status is-cached">
        <Icon name="check" size={12} />
        Cached
      </span>
    );
  }
  if (coverage.status === "partial") {
    const percent = Math.max(
      1,
      Math.floor(
        (coverage.cachedDays / Math.max(coverage.cacheableDays, 1)) * 100,
      ),
    );
    return (
      <span className="range-card-status is-partial">
        <span className="range-card-meter" aria-hidden="true">
          <i style={{ width: `${percent}%` }} />
        </span>
        {percent}% cached
      </span>
    );
  }
  const effort = loadEffort(coverage.totalDays - coverage.cachedDays);
  return (
    <span className="range-card-status">
      <span className="range-card-effort" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((step) => (
          <i key={step} className={step <= effort ? "on" : ""} />
        ))}
      </span>
      {EFFORT_LABELS[effort - 1]}
    </span>
  );
}

function coverageSentence(coverage: RangeCoverage): string {
  const toFetch = coverage.totalDays - coverage.cachedDays;
  if (coverage.cachedDays === 0) {
    return `${countFormat.format(coverage.totalDays)} days to fetch from Cursor`;
  }
  return `${countFormat.format(coverage.cachedDays)} cached · ${countFormat.format(toFetch)} to fetch`;
}

export function RangeStep({
  initial,
  remembered,
  coverage,
  today,
  onConfirm,
}: {
  initial: StartupRange;
  remembered: StartupRange | null;
  coverage: CacheCoverage | null;
  today: string;
  onConfirm: (range: StartupRange) => void;
}) {
  const ids = useId();
  const initialDates = resolveStartupRange(initial, today);
  const [mode, setMode] = useState<"preset" | "custom">(
    initial.kind === "preset" &&
      (STARTUP_PRESETS as readonly number[]).includes(initial.days)
      ? "preset"
      : "custom",
  );
  const [presetDays, setPresetDays] = useState(
    initial.kind === "preset" ? initial.days : 0,
  );
  const [startDate, setStartDate] = useState(initialDates.startDate);
  const [endDate, setEndDate] = useState(initialDates.endDate);
  // A non-card default such as 14 days stays a rolling preset until edited.
  const [rollingDays, setRollingDays] = useState(
    initial.kind === "preset" && mode === "custom" ? initial.days : 0,
  );

  const warm = Boolean(coverage && coverage.days > 0);
  const presets = useMemo(
    () =>
      STARTUP_PRESETS.map((days) => {
        const range = resolveStartupRange({ kind: "preset", days }, today);
        return { days, range, coverage: rangeCoverage(coverage, range) };
      }),
    [coverage, today],
  );

  const check = checkCustomRange(startDate, endDate, today);
  const selection: StartupRange | null =
    mode === "preset"
      ? { kind: "preset", days: presetDays }
      : rollingDays > 0
        ? { kind: "preset", days: rollingDays }
        : check.valid
          ? { kind: "custom", startDate, endDate }
          : null;
  const selectedDates = selection
    ? resolveStartupRange(selection, today)
    : null;
  const selectedCoverage = selectedDates
    ? rangeCoverage(coverage, selectedDates)
    : null;
  const selectedDays = selectedCoverage?.totalDays ?? check.days;

  const choosePreset = (days: number) => {
    const range = resolveStartupRange({ kind: "preset", days }, today);
    setMode("preset");
    setPresetDays(days);
    setRollingDays(0);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  };
  const editCustom = (next: { startDate?: string; endDate?: string }) => {
    setMode("custom");
    setRollingDays(0);
    if (next.startDate !== undefined) setStartDate(next.startDate);
    if (next.endDate !== undefined) setEndDate(next.endDate);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selection) onConfirm(selection);
  };

  const message =
    mode === "custom" && rollingDays === 0 && !check.valid ? check.error : null;

  return (
    <form
      className="range-step setup-step"
      onSubmit={submit}
      aria-describedby={`${ids}-summary`}
    >
      <fieldset className="range-presets">
        <legend className="sr-only">Preset ranges</legend>
        {presets.map(({ days, range, coverage: presetCoverage }) => {
          const checked = mode === "preset" && presetDays === days;
          const lastUsed = sameStartupRange(remembered, {
            kind: "preset",
            days,
          });
          return (
            <label
              key={days}
              className={`range-card${checked ? " is-selected" : ""}${
                presetCoverage.status === "full" ? " is-cached" : ""
              }`}
            >
              <input
                className="sr-only"
                type="radio"
                name={`${ids}-preset`}
                value={days}
                checked={checked}
                onChange={() => choosePreset(days)}
                aria-describedby={`${ids}-preset-${days}`}
                {...(checked ? { "data-dialog-initial-focus": true } : {})}
              />
              <span className="range-card-check" aria-hidden="true">
                <Icon name="check" size={12} />
              </span>
              {lastUsed && <span className="range-card-tag">Last used</span>}
              <span className="range-card-value">
                <strong>{days}</strong>
                <small>days</small>
              </span>
              <span className="range-card-caption">
                {PRESET_CAPTIONS[days]}
              </span>
              <span id={`${ids}-preset-${days}`} className="range-card-foot">
                <span className="sr-only">
                  {rangeLabel(range.startDate, range.endDate)}.{" "}
                </span>
                <CoverageRow coverage={presetCoverage} />
              </span>
            </label>
          );
        })}
      </fieldset>

      <fieldset
        className={`range-custom${mode === "custom" ? " is-active" : ""}${
          message ? " has-error" : ""
        }`}
      >
        <legend>
          <Icon name="calendar" size={14} />
          Custom range
        </legend>
        <div className="range-custom-fields">
          <label>
            <span>Start date</span>
            <input
              type="date"
              value={startDate}
              max={endDate || today}
              onChange={(event) =>
                editCustom({ startDate: event.target.value })
              }
              aria-invalid={Boolean(message)}
              aria-describedby={`${ids}-custom-message`}
            />
          </label>
          <span className="range-custom-arrow" aria-hidden="true">
            <Icon name="arrow" size={14} />
          </span>
          <label>
            <span>End date</span>
            <input
              type="date"
              value={endDate}
              min={startDate}
              max={today}
              onChange={(event) => editCustom({ endDate: event.target.value })}
              aria-invalid={Boolean(message)}
              aria-describedby={`${ids}-custom-message`}
            />
          </label>
          <output className="range-custom-count" aria-label="Days in range">
            {selectedDays === null ? "—" : countFormat.format(selectedDays)}
            <small>{selectedDays === 1 ? "day" : "days"}</small>
          </output>
        </div>
        <p
          id={`${ids}-custom-message`}
          className="range-custom-message"
          role={message ? "alert" : undefined}
        >
          {message ?? `Inclusive UTC dates, up to ${MAX_DATE_RANGE_DAYS} days.`}
        </p>
      </fieldset>

      <div className="range-summary" id={`${ids}-summary`} aria-live="polite">
        <span className="range-summary-icon" aria-hidden="true">
          <Icon
            name={selectedCoverage?.status === "full" ? "bolt" : "activity"}
            size={16}
          />
        </span>
        <span className="range-summary-copy">
          <strong>
            {selectedDates
              ? rangeLabel(selectedDates.startDate, selectedDates.endDate)
              : "Choose a valid range"}
          </strong>
          <small>
            {selectedCoverage
              ? selectedCoverage.status === "full"
                ? "Every cacheable day is cached, so this loads almost instantly."
                : coverageSentence(selectedCoverage)
              : "Ranges are inclusive and limited to 366 days."}
          </small>
        </span>
      </div>

      <div className="range-actions">
        <button
          className="setup-submit range-submit"
          type="submit"
          disabled={!selection}
        >
          {selectedDays === null || !selection
            ? "Load dashboard"
            : `Load ${countFormat.format(selectedDays)} ${selectedDays === 1 ? "day" : "days"}`}
          <Icon name="arrow" size={16} />
        </button>
        <p className="range-note">
          {warm
            ? "Cached days load instantly; only missing days are fetched."
            : "Longer ranges take longer the first time. Loaded days are cached, so later loads are faster."}{" "}
          Your choice is remembered.
        </p>
      </div>
    </form>
  );
}
