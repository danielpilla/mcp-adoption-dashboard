import { useEffect, useMemo, useRef, useState } from "react";
import type { AssociationOption } from "./associative-model";
import { Icon } from "../interface/icon";
import {
  valuesForAssociationAction,
  type AssociationSelectionAction,
  type SelectionField,
} from "./selection-model";

export interface SelectionActionField {
  field: SelectionField;
  label: string;
  options: AssociationOption[];
  locked?: boolean;
  onToggleLock?: () => void;
}

export function SelectionToolbar({
  active = true,
  count,
  onApply,
  onCancel,
  fields = [],
  onSelectValues,
}: {
  active?: boolean;
  count: number;
  onApply: () => void;
  onCancel: () => void;
  fields?: SelectionActionField[];
  onSelectValues?: (field: SelectionField, values: string[]) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasActiveRef = useRef(active);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [activeField, setActiveField] = useState<SelectionField | "">(
    fields[0]?.field ?? "",
  );
  useEffect(() => {
    if (!fields.some((field) => field.field === activeField)) {
      setActiveField(fields[0]?.field ?? "");
    }
  }, [activeField, fields]);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (wasActive && !active) {
      window.setTimeout(() => triggerRef.current?.focus());
    }
  }, [active]);
  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setActionsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setActionsOpen(false);
      window.setTimeout(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [actionsOpen]);
  const selectedField = fields.find((field) => field.field === activeField);
  const actions = useMemo(
    () =>
      (["all", "possible", "alternative", "excluded"] as const).map(
        (action) => ({
          action,
          values: selectedField
            ? valuesForAssociationAction(selectedField.options, action)
            : [],
        }),
      ),
    [selectedField],
  );
  const applyAction = (
    action: AssociationSelectionAction,
    values: string[],
  ) => {
    if (
      !selectedField ||
      selectedField.locked ||
      !onSelectValues ||
      values.length === 0
    )
      return;
    onSelectValues(selectedField.field, values);
    setActionsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus());
  };

  return (
    <div
      ref={rootRef}
      className={`visual-selection-toolbar${active ? " active" : ""}`}
      role="toolbar"
      aria-label="Visual selections"
    >
      {!active && fields.length > 0 && onSelectValues && (
        <div className="visual-selection-actions">
          <button
            ref={triggerRef}
            type="button"
            className="selection-actions-trigger"
            onClick={() => setActionsOpen((open) => !open)}
            aria-expanded={actionsOpen}
            aria-haspopup="dialog"
          >
            <Icon name="filter" size={13} />
            <span>Select</span>
            <span className="selection-actions-caret">⌄</span>
          </button>
          {actionsOpen && selectedField && (
            <div
              className="selection-actions-popover"
              role="dialog"
              aria-modal="false"
              aria-label="Association selection actions"
            >
              {fields.length > 1 ? (
                <label>
                  <span>Dimension</span>
                  <select
                    value={activeField}
                    onChange={(event) =>
                      setActiveField(event.target.value as SelectionField)
                    }
                    aria-label="Selection action dimension"
                  >
                    {fields.map((field) => (
                      <option key={field.field} value={field.field}>
                        {field.locked ? `Locked — ${field.label}` : field.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <strong>
                  {selectedField.locked && (
                    <>
                      <Icon name="lock" size={12} />
                      <span className="sr-only">Locked: </span>
                    </>
                  )}
                  {selectedField.label}
                </strong>
              )}
              {selectedField.onToggleLock && (
                <button
                  type="button"
                  className="selection-field-lock-action"
                  onClick={selectedField.onToggleLock}
                  disabled={
                    !selectedField.locked &&
                    !selectedField.options.some(
                      (option) =>
                        option.state === "selected" ||
                        option.state === "selectedExcluded",
                    )
                  }
                >
                  {selectedField.locked ? "Unlock field" : "Lock field"}
                </button>
              )}
              <div>
                {actions.map(({ action, values }) => (
                  <button
                    type="button"
                    key={action}
                    onClick={() => applyAction(action, values)}
                    disabled={selectedField.locked || values.length === 0}
                  >
                    Select {action} <span>{values.length}</span>
                  </button>
                ))}
              </div>
              {actions.some(
                ({ action, values }) =>
                  action === "excluded" &&
                  selectedField.options.some(
                    (option) => option.state === "alternative",
                  ) &&
                  values.length > 0,
              ) && (
                <small>
                  Excluded values do not match the current selections.
                </small>
              )}
              {selectedField.locked && (
                <small>Unlock this field before changing its selection.</small>
              )}
            </div>
          )}
        </div>
      )}
      {active && (
        <div
          className="selection-confirmation"
          role="toolbar"
          aria-label="Pending selections"
        >
          <span aria-live="polite">
            <strong>{count}</strong> pending{" "}
            {count === 1 ? "change" : "changes"}
            <span className="sr-only">
              . Press Enter to apply or Escape to cancel.
            </span>
          </span>
          <button
            type="button"
            className="selection-cancel"
            onClick={onCancel}
            aria-label="Cancel pending selections"
            title="Cancel (Esc)"
          >
            Cancel
          </button>
          <button
            type="button"
            className="selection-apply"
            onClick={onApply}
            aria-label="Apply pending selections"
            title="Apply (Enter)"
          >
            <span>Apply selection</span>✓
          </button>
        </div>
      )}
    </div>
  );
}
