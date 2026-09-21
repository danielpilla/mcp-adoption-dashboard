import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AssociationOption } from "./associative-model";
import {
  TEMPORAL_FILTER_FIELDS,
  TEMPORAL_FIELD_LABELS,
  type Filters,
  type TemporalFilterField,
} from "./filter-model";
import { Icon } from "../interface/icon";
import { MultiSelectFilter } from "./multi-select-filter";
import type { SelectionField } from "./selection-model";

export function TemporalFilterGroup({
  options,
  filters,
  onChange,
  lockedFields,
  onToggleLock,
  openRequest = 0,
  openField,
}: {
  options: Record<TemporalFilterField, AssociationOption[]>;
  filters: Filters;
  onChange: (filters: Filters) => void;
  lockedFields: Set<SelectionField>;
  onToggleLock: (field: SelectionField) => void;
  openRequest?: number;
  openField?: TemporalFilterField;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const selectedCount = TEMPORAL_FILTER_FIELDS.reduce(
    (count, field) => count + filters[field].length,
    0,
  );
  const positionMenu = () => {
    if (!rootRef.current) return;
    const bounds = rootRef.current.getBoundingClientRect();
    const viewportPadding = 12;
    const width = Math.min(640, window.innerWidth - viewportPadding * 2);
    const nestedMenuReserve = window.innerWidth >= 900 ? 352 : 0;
    const spaceAbove = Math.max(180, bounds.top - viewportPadding);
    const spaceBelow = Math.max(
      180,
      window.innerHeight - bounds.bottom - viewportPadding,
    );
    const openUp = spaceAbove > spaceBelow;
    const left = Math.max(
      viewportPadding,
      Math.min(
        bounds.right - width,
        window.innerWidth - width - viewportPadding - nestedMenuReserve,
      ),
    );
    const maxHeight = Math.min(620, openUp ? spaceAbove - 8 : spaceBelow - 8);
    setMenuStyle({
      position: "fixed",
      width: `${width}px`,
      left: `${left}px`,
      right: "auto",
      top: openUp ? "auto" : `${bounds.bottom + 8}px`,
      bottom: openUp ? `${window.innerHeight - bounds.top + 8}px` : "auto",
      maxHeight: `${maxHeight}px`,
      overflowY: "auto",
    });
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !open) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      window.setTimeout(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!openRequest) return;
    positionMenu();
    setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => positionMenu();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  return (
    <div className="temporal-filter-group" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`multi-filter-trigger temporal-group-trigger ${
          selectedCount ? "active" : ""
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (!open) positionMenu();
          setOpen((current) => !current);
        }}
      >
        <Icon name="calendar" size={15} />
        <span>Time</span>
        {selectedCount > 0 && <strong>{selectedCount}</strong>}
        <span className="multi-filter-caret">⌄</span>
      </button>
      {open && (
        <div
          className="temporal-group-menu"
          role="dialog"
          aria-modal="false"
          aria-label="Time filters"
          style={menuStyle}
        >
          <div className="temporal-group-header">
            <div>
              <strong>Time dimensions</strong>
              <span>Combine any fields using associative AND</span>
            </div>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...filters,
                    dates: lockedFields.has("dates") ? filters.dates : [],
                    days: lockedFields.has("days") ? filters.days : [],
                    weeks: lockedFields.has("weeks") ? filters.weeks : [],
                    months: lockedFields.has("months") ? filters.months : [],
                    monthYears: lockedFields.has("monthYears")
                      ? filters.monthYears
                      : [],
                    quarters: lockedFields.has("quarters")
                      ? filters.quarters
                      : [],
                    years: lockedFields.has("years") ? filters.years : [],
                  })
                }
              >
                Clear time
              </button>
            )}
          </div>
          <div className="temporal-subfilters">
            {TEMPORAL_FILTER_FIELDS.map((field) => (
              <MultiSelectFilter
                key={field}
                label={TEMPORAL_FIELD_LABELS[field]}
                kind="calendar"
                options={options[field]}
                selected={filters[field]}
                locked={lockedFields.has(field)}
                onToggleLock={() => onToggleLock(field)}
                openRequest={openField === field ? openRequest : 0}
                onChange={(values) => onChange({ ...filters, [field]: values })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
