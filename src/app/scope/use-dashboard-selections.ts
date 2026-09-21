import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Filters } from "./filter-model";
import {
  mergeSelectionChanges,
  sameSelection,
  toggleSelectionChange,
  type SelectionChanges,
  type SelectionField,
} from "./selection-model";

const SELECTION_FIELD_LABELS: Record<SelectionField, string> = {
  origins: "MCP type",
  users: "Users",
  servers: "MCPs",
  tools: "Tools",
  groups: "Groups",
  dates: "Date",
  days: "Day of month",
  weeks: "ISO week",
  months: "Month",
  monthYears: "Month-Year",
  quarters: "Quarter",
  years: "Year",
};

export interface VisualSelectionSession {
  source: string;
  changes: SelectionChanges;
}

interface UseDashboardSelectionsOptions {
  filters: Filters;
  setFilters: Dispatch<SetStateAction<Filters>>;
  initialLockedFields: readonly SelectionField[];
  setToast: Dispatch<SetStateAction<string>>;
}

export function useDashboardSelections({
  filters,
  setFilters,
  initialLockedFields,
  setToast,
}: UseDashboardSelectionsOptions) {
  const [lockedFields, setLockedFields] = useState<Set<SelectionField>>(
    () => new Set(initialLockedFields),
  );
  const [selectionSession, setSelectionSession] =
    useState<VisualSelectionSession | null>(null);

  const toggleFieldLock = useCallback(
    (field: SelectionField) => {
      if (!lockedFields.has(field) && filters[field].length === 0) {
        setToast(
          `Select ${SELECTION_FIELD_LABELS[field]} values before locking`,
        );
        return;
      }
      setLockedFields((current) => {
        const next = new Set(current);
        if (next.has(field)) {
          next.delete(field);
        } else {
          next.add(field);
        }
        return next;
      });
    },
    [filters, lockedFields, setToast],
  );

  const rejectLockedFieldChange = useCallback(
    (field: SelectionField) => {
      if (!lockedFields.has(field)) return false;
      setToast(
        `${SELECTION_FIELD_LABELS[field]} is locked. Unlock it before changing the selection.`,
      );
      return true;
    },
    [lockedFields, setToast],
  );

  const previewFilters = useMemo(() => {
    if (!selectionSession) return filters;
    return mergeSelectionChanges(filters, selectionSession.changes);
  }, [filters, selectionSession]);

  const pendingChangeCount = useMemo(
    () =>
      selectionSession
        ? Object.entries(selectionSession.changes).reduce(
            (count, [field, values]) => {
              const baseline = filters[field as SelectionField];
              const nextValues = values ?? [];
              const baselineValues = new Set(baseline);
              const nextValueSet = new Set(nextValues);
              return (
                count +
                baseline.filter((value) => !nextValueSet.has(value)).length +
                nextValues.filter((value) => !baselineValues.has(value)).length
              );
            },
            0,
          )
        : 0,
    [filters, selectionSession],
  );

  const applyPendingSelections = useCallback(() => {
    if (!selectionSession) return;
    setFilters((filtersBeforeApply) =>
      mergeSelectionChanges(filtersBeforeApply, selectionSession.changes),
    );
    setSelectionSession(null);
  }, [selectionSession, setFilters]);

  const cancelPendingSelections = useCallback(() => {
    setSelectionSession(null);
  }, []);

  const togglePendingSelection = useCallback(
    (source: string, field: SelectionField, value: string) => {
      if (rejectLockedFieldChange(field)) return;
      setSelectionSession((current) => {
        const changes = toggleSelectionChange(
          filters,
          current?.changes ?? {},
          field,
          value,
        );
        return Object.keys(changes).length > 0 ? { source, changes } : null;
      });
    },
    [filters, rejectLockedFieldChange],
  );

  const addPendingSelectionValues = useCallback(
    (source: string, field: SelectionField, values: string[]) => {
      if (rejectLockedFieldChange(field)) return;
      setSelectionSession((current) => {
        const currentValues = current?.changes[field] ?? filters[field];
        const nextValues = [...new Set([...currentValues, ...values])];
        const changes: SelectionChanges = {
          ...(current?.changes ?? {}),
        };
        if (sameSelection(nextValues, filters[field])) {
          delete changes[field];
        } else {
          changes[field] = nextValues;
        }
        return Object.keys(changes).length > 0 ? { source, changes } : null;
      });
    },
    [filters, rejectLockedFieldChange],
  );

  const replacePendingSelectionValues = useCallback(
    (source: string, field: SelectionField, values: string[]) => {
      if (rejectLockedFieldChange(field)) return;
      setSelectionSession((current) => {
        const changes: SelectionChanges = {
          ...(current?.changes ?? {}),
        };
        if (sameSelection(values, filters[field])) {
          delete changes[field];
        } else {
          changes[field] = [...values];
        }
        return Object.keys(changes).length > 0 ? { source, changes } : null;
      });
    },
    [filters, rejectLockedFieldChange],
  );

  const commitFieldSelection = useCallback(
    (field: SelectionField, values: string[]) => {
      if (rejectLockedFieldChange(field)) return;
      setFilters((current) => ({ ...current, [field]: values }));
    },
    [rejectLockedFieldChange, setFilters],
  );

  useEffect(() => {
    if (!selectionSession) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelPendingSelections();
        return;
      }
      const target = event.target as HTMLElement | null;
      // ARIA chart buttons are intentionally omitted: once they start a
      // visual selection session, Enter commits it while Space keeps toggling.
      if (
        target?.matches(
          "button, a, input, textarea, select, [contenteditable='true'], [role='option'], [role='region']",
        )
      ) {
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
        applyPendingSelections();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [applyPendingSelections, cancelPendingSelections, selectionSession]);

  useEffect(() => {
    setSelectionSession(null);
  }, [filters]);

  return {
    lockedFields,
    selectionSession,
    previewFilters,
    pendingChangeCount,
    toggleFieldLock,
    rejectLockedFieldChange,
    applyPendingSelections,
    cancelPendingSelections,
    togglePendingSelection,
    addPendingSelectionValues,
    replacePendingSelectionValues,
    commitFieldSelection,
  };
}
