import type { Filters } from "./filter-model";
import type { Dimension } from "../pivot/pivot-model";
import type { AssociationState } from "./associative-model";
import { isMcpOrigin } from "../../contracts/mcp-origin";

export type SelectionField = Exclude<keyof Filters, "query">;
export type SelectionChanges = Partial<Record<SelectionField, string[]>>;
export type AssociationSelectionAction =
  "all" | "possible" | "alternative" | "excluded";

const SELECTION_FIELDS: SelectionField[] = [
  "origins",
  "users",
  "servers",
  "tools",
  "groups",
  "dates",
  "days",
  "weeks",
  "months",
  "monthYears",
  "quarters",
  "years",
];

export const DIMENSION_SELECTION_FIELDS: Record<Dimension, SelectionField> = {
  server: "servers",
  group: "groups",
  tool: "tools",
  user: "users",
  date: "dates",
  day: "days",
  week: "weeks",
  month: "months",
  monthYear: "monthYears",
  quarter: "quarters",
  year: "years",
};

export function sameSelection(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
}

export function toggleSelectionChange(
  filters: Filters,
  changes: SelectionChanges,
  field: SelectionField,
  value: string,
): SelectionChanges {
  const currentValues = changes[field] ?? filters[field];
  const nextValues = currentValues.includes(value)
    ? currentValues.filter((item) => item !== value)
    : [...currentValues, value];
  const nextChanges = { ...changes };
  if (sameSelection(nextValues, filters[field])) {
    delete nextChanges[field];
  } else {
    nextChanges[field] = nextValues;
  }
  return nextChanges;
}

export function mergeSelectionChanges(
  filters: Filters,
  changes: SelectionChanges,
): Filters {
  const merged = { ...filters };
  for (const field of SELECTION_FIELDS) {
    const values = changes[field];
    if (values === undefined) continue;
    if (field === "origins") {
      merged.origins = values.filter(isMcpOrigin);
    } else {
      merged[field] = values;
    }
  }
  return merged;
}

export function valuesForAssociationAction(
  options: Array<{ value: string; state?: AssociationState }>,
  action: AssociationSelectionAction,
): string[] {
  if (action === "all") return options.map((option) => option.value);
  if (action === "possible") {
    return options
      .filter((option) => option.state === "possible")
      .map((option) => option.value);
  }
  if (action === "alternative") {
    return options
      .filter((option) => option.state === "alternative")
      .map((option) => option.value);
  }
  return options
    .filter((option) => option.state === "excluded")
    .map((option) => option.value);
}

export function clearUnlockedSelections(
  filters: Filters,
  lockedFields: ReadonlySet<SelectionField>,
): Filters {
  const next = { ...filters, query: "" };
  for (const field of SELECTION_FIELDS) {
    if (!lockedFields.has(field)) next[field] = [];
  }
  return next;
}

export function countUnlockedSelections(
  filters: Filters,
  lockedFields: ReadonlySet<SelectionField>,
): number {
  const selectedValues = SELECTION_FIELDS.reduce(
    (total, field) =>
      total + (lockedFields.has(field) ? 0 : filters[field].length),
    0,
  );
  return selectedValues + (filters.query ? 1 : 0);
}

export function countSelections(filters: Filters): number {
  return (
    SELECTION_FIELDS.reduce(
      (total, field) => total + filters[field].length,
      0,
    ) + (filters.query ? 1 : 0)
  );
}
