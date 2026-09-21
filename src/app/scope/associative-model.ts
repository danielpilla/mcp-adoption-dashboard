import type { McpRecord } from "../../contracts/mcp-response";
import {
  classifyMcpServer,
  isInternalMcpServer,
} from "../../contracts/mcp-origin";
import {
  groupValueLabel,
  NO_GROUP_VALUE,
  recordMatchesQuery,
  temporalValue,
  type Filters,
  type TemporalFilterField,
} from "./filter-model";

export type AssociationField =
  "users" | "origins" | "servers" | "tools" | "groups" | TemporalFilterField;
export type AssociationState =
  "selected" | "possible" | "alternative" | "excluded" | "selectedExcluded";

export interface AssociationOption {
  value: string;
  label: string;
  detail?: string;
  badge?: string;
  state: AssociationState;
  count: number;
  usage: number;
}

export interface AssociativeModel {
  records: McpRecord[];
  contextRecords: Record<AssociationField, McpRecord[]>;
  networkRecords: McpRecord[];
  options: Record<AssociationField, AssociationOption[]>;
  stateCounts: Record<AssociationField, Record<AssociationState, number>>;
}

const FIELDS: AssociationField[] = [
  "users",
  "origins",
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
export const ASSOCIATION_STATE_ORDER: AssociationState[] = [
  "selected",
  "selectedExcluded",
  "possible",
  "alternative",
  "excluded",
];

function valuesForField(record: McpRecord, field: AssociationField): string[] {
  if (field === "users") return [record.email];
  if (field === "origins") {
    return [record.origin ?? classifyMcpServer(record.server)];
  }
  if (field === "servers") return [record.server];
  if (field === "tools") return [record.tool];
  if (field === "groups")
    return record.directoryGroups?.length
      ? [...new Set(record.directoryGroups)]
      : [NO_GROUP_VALUE];
  return [temporalValue(record.date, field)];
}

export class InMemoryAssociativeEngine {
  private readonly indexes = Object.fromEntries(
    FIELDS.map((field) => [field, new Map<string, Set<number>>()]),
  ) as Record<AssociationField, Map<string, Set<number>>>;
  private readonly labels = Object.fromEntries(
    FIELDS.map((field) => [
      field,
      new Map<string, { label: string; detail?: string; badge?: string }>(),
    ]),
  ) as Record<
    AssociationField,
    Map<string, { label: string; detail?: string; badge?: string }>
  >;
  private readonly allRowIds: number[];

  constructor(private readonly sourceRecords: McpRecord[]) {
    this.allRowIds = sourceRecords.map((_, index) => index);
    sourceRecords.forEach((record, rowId) => {
      for (const field of FIELDS) {
        for (const value of valuesForField(record, field)) {
          const rows = this.indexes[field].get(value) ?? new Set<number>();
          rows.add(rowId);
          this.indexes[field].set(value, rows);
          if (!this.labels[field].has(value)) {
            this.labels[field].set(
              value,
              field === "users"
                ? {
                    label: record.displayName || value,
                    detail:
                      record.displayName && record.displayName !== value
                        ? value
                        : undefined,
                  }
                : field === "origins"
                  ? {
                      label: value === "internal" ? "Internal" : "External",
                    }
                  : field === "servers"
                    ? {
                        label: value,
                        badge: isInternalMcpServer(value)
                          ? "Internal"
                          : undefined,
                      }
                    : field === "groups"
                      ? { label: groupValueLabel(value) }
                      : { label: value },
            );
          }
        }
      }
    });
  }

  private recordAt(rowId: number): McpRecord {
    const record = this.sourceRecords[rowId];
    if (!record) {
      throw new RangeError(`Unknown associative row: ${rowId}`);
    }
    return record;
  }

  evaluate(filters: Filters): AssociativeModel {
    const queryRowIds = filters.query
      ? this.allRowIds.filter((rowId) =>
          recordMatchesQuery(this.recordAt(rowId), filters.query),
        )
      : this.allRowIds;
    const selections = Object.fromEntries(
      FIELDS.map((field) => [field, new Set(filters[field])]),
    ) as Record<AssociationField, Set<string>>;
    const selectedRows = Object.fromEntries(
      FIELDS.map((field) => {
        const rows = new Set<number>();
        for (const value of selections[field]) {
          for (const rowId of this.indexes[field].get(value) ?? []) {
            rows.add(rowId);
          }
        }
        return [field, rows];
      }),
    ) as Record<AssociationField, Set<number>>;

    const inferRows = (
      exceptFields: ReadonlySet<AssociationField> = new Set(),
    ) =>
      queryRowIds.filter((rowId) =>
        FIELDS.every(
          (field) =>
            exceptFields.has(field) ||
            selections[field].size === 0 ||
            selectedRows[field].has(rowId),
        ),
      );

    const associatedRowIds = inferRows();
    const options = {} as AssociativeModel["options"];
    const contextRecords = {} as AssociativeModel["contextRecords"];
    const stateCounts = {} as AssociativeModel["stateCounts"];

    for (const field of FIELDS) {
      const possibleRows = inferRows(new Set([field]));
      contextRecords[field] = possibleRows.map((rowId) => this.recordAt(rowId));
      const associations = new Map<string, { count: number; usage: number }>();
      for (const rowId of possibleRows) {
        const record = this.recordAt(rowId);
        for (const value of valuesForField(record, field)) {
          const current = associations.get(value) ?? { count: 0, usage: 0 };
          current.count += 1;
          current.usage += record.usage;
          associations.set(value, current);
        }
      }

      const universe = new Set([
        ...this.indexes[field].keys(),
        ...selections[field],
      ]);
      const fieldOptions = [...universe].map((value) => {
        const association = associations.get(value);
        let state: AssociationState;
        if (selections[field].has(value)) {
          state = association ? "selected" : "selectedExcluded";
        } else if (association) {
          state = selections[field].size > 0 ? "alternative" : "possible";
        } else {
          state = "excluded";
        }
        const display = this.labels[field].get(value) ?? { label: value };
        return {
          value,
          ...display,
          state,
          count: association?.count ?? 0,
          usage: association?.usage ?? 0,
        };
      });
      fieldOptions.sort(
        (a, b) =>
          ASSOCIATION_STATE_ORDER.indexOf(a.state) -
            ASSOCIATION_STATE_ORDER.indexOf(b.state) ||
          b.usage - a.usage ||
          a.label.localeCompare(b.label),
      );
      options[field] = fieldOptions;
      stateCounts[field] = ASSOCIATION_STATE_ORDER.reduce(
        (counts, state) => {
          counts[state] = fieldOptions.filter(
            (option) => option.state === state,
          ).length;
          return counts;
        },
        {} as Record<AssociationState, number>,
      );
    }

    return {
      records: associatedRowIds.map((rowId) => this.recordAt(rowId)),
      contextRecords,
      networkRecords: inferRows(new Set(["servers", "users"])).map((rowId) =>
        this.recordAt(rowId),
      ),
      options,
      stateCounts,
    };
  }
}

export function buildAssociativeModel(
  records: McpRecord[],
  filters: Filters,
): AssociativeModel {
  return new InMemoryAssociativeEngine(records).evaluate(filters);
}
