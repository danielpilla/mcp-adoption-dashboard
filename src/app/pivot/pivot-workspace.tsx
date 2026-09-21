import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { McpRecord } from "../../contracts/mcp-response";
import { formatNumber } from "../analytics/activity-metrics";
import type { AssociationOption } from "../scope/associative-model";
import {
  buildPivot,
  dimensionValue,
  DIMENSION_LABELS,
  pivotCellKey,
  type Dimension,
  type PivotTreeNode,
  type PivotValue,
} from "./pivot-model";
import { groupValueLabel, type Filters } from "../scope/filter-model";
import { Icon } from "../interface/icon";
import { McpServerLabel } from "../relationships/mcp-server-label";
import { MultiSelectFilter } from "../scope/multi-select-filter";
import { SelectionMark } from "../scope/selection-mark";
import { SelectionToolbar } from "../scope/selection-toolbar";
import {
  DIMENSION_SELECTION_FIELDS,
  type SelectionField,
} from "../scope/selection-model";

const DIMENSIONS: Dimension[] = [
  "server",
  "group",
  "tool",
  "user",
  "date",
  "day",
  "week",
  "month",
  "monthYear",
  "quarter",
  "year",
];
const ROW_PAGE_SIZE = 60;
const COLUMN_PAGE_SIZE = 24;

function flattenTree(
  nodes: PivotTreeNode[],
  expanded: Set<string>,
): PivotTreeNode[] {
  const visible: PivotTreeNode[] = [];
  for (const node of nodes) {
    visible.push(node);
    if (node.children.length > 0 && expanded.has(node.key)) {
      visible.push(...flattenTree(node.children, expanded));
    }
  }
  return visible;
}

type SortKey = "__label__" | "__total__" | string;
type SortDirection = "asc" | "desc";

function sortTree(
  nodes: PivotTreeNode[],
  sortKey: SortKey,
  direction: SortDirection,
): PivotTreeNode[] {
  const multiplier = direction === "asc" ? 1 : -1;
  const compare = (a: PivotTreeNode, b: PivotTreeNode) => {
    if (sortKey === "__label__") {
      return a.label.localeCompare(b.label) * multiplier;
    }
    const aValue =
      sortKey === "__total__" ? a.total : (a.values.get(sortKey) ?? 0);
    const bValue =
      sortKey === "__total__" ? b.total : (b.values.get(sortKey) ?? 0);
    return (aValue - bValue) * multiplier || a.label.localeCompare(b.label);
  };
  return [...nodes].sort(compare).map((node) => ({
    ...node,
    children: sortTree(node.children, sortKey, direction),
  }));
}

function DimensionChip({
  dimension,
  onRemove,
  onMove,
  onActivate,
  onAddToColumns,
  onMoveZone,
  moveZoneLabel,
  canMoveLeft,
  canMoveRight,
}: {
  dimension: Dimension;
  onRemove?: () => void;
  onMove?: (offset: number) => void;
  onActivate?: () => void;
  onAddToColumns?: () => void;
  onMoveZone?: () => void;
  moveZoneLabel?: string;
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = DIMENSION_LABELS[dimension];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
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

  const run = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <span className="dimension-chip-shell" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="dimension-chip"
        draggable
        aria-expanded={open}
        onDragStart={(event) => {
          event.dataTransfer.setData("text/dimension", dimension);
          event.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>
      {open && (
        <span className="dimension-chip-menu">
          {onActivate && onAddToColumns && (
            <>
              <button type="button" onClick={() => run(onActivate)}>
                Add to rows
              </button>
              <button type="button" onClick={() => run(onAddToColumns)}>
                Add to columns
              </button>
            </>
          )}
          {onMove && (
            <>
              <button
                type="button"
                disabled={!canMoveLeft}
                onClick={() => run(() => onMove(-1))}
              >
                Move left
              </button>
              <button
                type="button"
                disabled={!canMoveRight}
                onClick={() => run(() => onMove(1))}
              >
                Move right
              </button>
            </>
          )}
          {onMoveZone && (
            <button type="button" onClick={() => run(onMoveZone)}>
              {moveZoneLabel?.replace(`Move ${label} to `, "Move to ")}
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="danger"
              onClick={() => run(onRemove)}
            >
              Remove field
            </button>
          )}
        </span>
      )}
    </span>
  );
}

function PivotDimensionValue({
  dimension,
  label,
  selectionValue,
  selectedFilters,
  onToggleSelection,
  showSelection,
}: {
  dimension?: Dimension;
  label: string;
  selectionValue: string;
  selectedFilters: Filters;
  onToggleSelection: (field: SelectionField, value: string) => void;
  showSelection: boolean;
}) {
  if (!dimension) {
    return (
      <span className="pivot-dimension-select static">
        <span>{label}</span>
      </span>
    );
  }
  const displayLabel = dimension === "group" ? groupValueLabel(label) : label;
  const field = DIMENSION_SELECTION_FIELDS[dimension];
  const selected =
    showSelection &&
    (selectedFilters[field] as readonly string[]).includes(selectionValue);
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`pivot-dimension-select chart-selectable${selected ? " selected" : ""}`}
      onClick={() => onToggleSelection(field, selectionValue)}
      aria-pressed={selected}
      aria-label={`${selected ? "Remove" : "Add"} ${displayLabel} ${DIMENSION_LABELS[dimension]} filter`}
    >
      <span>
        {dimension === "server" ? (
          <McpServerLabel server={displayLabel} />
        ) : (
          displayLabel
        )}
      </span>
      <SelectionMark selected={selected} />
    </button>
  );
}

function PivotHeaderFilter({
  dimension,
  selectedFilters,
  selectionOptions,
  lockedFields,
  onCommitSelection,
  onToggleLock,
}: {
  dimension: Dimension;
  selectedFilters: Filters;
  selectionOptions: Record<SelectionField, AssociationOption[]>;
  lockedFields: Set<SelectionField>;
  onCommitSelection: (field: SelectionField, values: string[]) => void;
  onToggleLock: (field: SelectionField) => void;
}) {
  const field = DIMENSION_SELECTION_FIELDS[dimension];
  const kind =
    dimension === "server"
      ? "server"
      : dimension === "user"
        ? "users"
        : dimension === "tool"
          ? "tools"
          : dimension === "group"
            ? "grid"
            : "calendar";
  return (
    <MultiSelectFilter
      compact
      label={DIMENSION_LABELS[dimension]}
      kind={kind}
      options={selectionOptions[field]}
      selected={selectedFilters[field]}
      onChange={(values) => onCommitSelection(field, values)}
      locked={lockedFields.has(field)}
      onToggleLock={() => onToggleLock(field)}
    />
  );
}

export const PivotWorkspace = memo(function PivotWorkspace({
  records,
  onPivotChange,
  selectedFilters,
  onToggleSelection,
  onSelectValues,
  onCommitSelection,
  selectionActive,
  pendingChangeCount,
  onApplySelection,
  onCancelSelection,
  selectionOptions,
  lockedFields,
  onToggleLock,
}: {
  records: McpRecord[];
  onPivotChange?: (pivot: ReturnType<typeof buildPivot> | null) => void;
  selectedFilters: Filters;
  onToggleSelection: (field: SelectionField, value: string) => void;
  onSelectValues: (field: SelectionField, values: string[]) => void;
  onCommitSelection: (field: SelectionField, values: string[]) => void;
  selectionActive: boolean;
  pendingChangeCount: number;
  onApplySelection: () => void;
  onCancelSelection: () => void;
  selectionOptions: Record<SelectionField, AssociationOption[]>;
  lockedFields: Set<SelectionField>;
  onToggleLock: (field: SelectionField) => void;
}) {
  const [rows, setRows] = useState<Dimension[]>(["server", "user"]);
  const [columns, setColumns] = useState<Dimension[]>([]);
  const [value, setValue] = useState<PivotValue>("usage");
  const [rowLayout, setRowLayout] = useState<"compact" | "tabular">("compact");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("__total__");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [showZeros, setShowZeros] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => window.matchMedia("(max-width: 820px)").matches,
  );
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const selectionFields = useMemo(
    () =>
      [...new Set([...rows, ...columns])].map((dimension) => {
        const field = DIMENSION_SELECTION_FIELDS[dimension];
        return {
          field,
          label: DIMENSION_LABELS[dimension],
          options: selectionOptions[field],
          locked: lockedFields.has(field),
          onToggleLock: () => onToggleLock(field),
        };
      }),
    [columns, lockedFields, onToggleLock, rows, selectionOptions],
  );
  const selectionValueFor = (
    dimension: Dimension | undefined,
    label: string,
  ) => {
    if (dimension !== "user") return label;
    return (
      records.find((record) => dimensionValue(record, dimension) === label)
        ?.email ?? label
    );
  };
  const pivot = useMemo(
    () => buildPivot(records, rows, columns, value),
    [records, rows, columns, value],
  );
  const columnPageCount = Math.max(
    1,
    Math.ceil(pivot.columnKeys.length / COLUMN_PAGE_SIZE),
  );
  const visibleColumns = pivot.columnKeys.slice(
    columnPage * COLUMN_PAGE_SIZE,
    (columnPage + 1) * COLUMN_PAGE_SIZE,
  );
  const sortedTree = useMemo(
    () => sortTree(pivot.rowTree, sortKey, sortDirection),
    [pivot.rowTree, sortKey, sortDirection],
  );
  const compactRows = useMemo(
    () => flattenTree(sortedTree, expandedKeys),
    [sortedTree, expandedKeys],
  );
  const sortedRowKeys = useMemo(() => {
    const multiplier = sortDirection === "asc" ? 1 : -1;
    return [...pivot.rowKeys].sort((a, b) => {
      const aLabel = pivot.rowLabels.get(a) ?? "";
      const bLabel = pivot.rowLabels.get(b) ?? "";
      if (sortKey === "__label__")
        return aLabel.localeCompare(bLabel) * multiplier || a.localeCompare(b);
      const aValue =
        sortKey === "__total__"
          ? (pivot.rowTotals.get(a) ?? 0)
          : (pivot.values.get(pivotCellKey(a, sortKey)) ?? 0);
      const bValue =
        sortKey === "__total__"
          ? (pivot.rowTotals.get(b) ?? 0)
          : (pivot.values.get(pivotCellKey(b, sortKey)) ?? 0);
      return (
        (aValue - bValue) * multiplier ||
        aLabel.localeCompare(bLabel) ||
        a.localeCompare(b)
      );
    });
  }, [
    pivot.rowKeys,
    pivot.rowLabels,
    pivot.rowTotals,
    pivot.values,
    sortDirection,
    sortKey,
  ]);
  const rowCount =
    rowLayout === "compact" ? compactRows.length : sortedRowKeys.length;
  const rowPageCount = Math.max(1, Math.ceil(rowCount / ROW_PAGE_SIZE));
  const visibleRows = sortedRowKeys.slice(
    rowPage * ROW_PAGE_SIZE,
    (rowPage + 1) * ROW_PAGE_SIZE,
  );
  const visibleCompactRows = compactRows.slice(
    rowPage * ROW_PAGE_SIZE,
    (rowPage + 1) * ROW_PAGE_SIZE,
  );
  const visibleValues = [
    ...visibleCompactRows.flatMap((node) => [
      node.total,
      ...visibleColumns.map((column) => node.values.get(column) ?? 0),
    ]),
    ...visibleRows.flatMap((row) => [
      pivot.rowTotals.get(row) ?? 0,
      ...visibleColumns.map(
        (column) => pivot.values.get(pivotCellKey(row, column)) ?? 0,
      ),
    ]),
  ];
  const maxVisibleValue = Math.max(...visibleValues, 1);
  const used = new Set([...rows, ...columns]);

  useEffect(() => {
    setRowPage(0);
    setColumnPage(0);
    setExpandedKeys(new Set());
  }, [records, rows, columns, value, rowLayout]);
  useEffect(() => {
    onPivotChange?.(pivot);
  }, [onPivotChange, pivot]);
  useEffect(
    () => () => {
      onPivotChange?.(null);
    },
    [onPivotChange],
  );
  useEffect(() => {
    setRowPage(0);
  }, [sortKey, sortDirection]);
  useEffect(() => {
    setRowPage((page) => Math.min(page, rowPageCount - 1));
  }, [rowPageCount]);
  useEffect(() => {
    setColumnPage((page) => Math.min(page, columnPageCount - 1));
  }, [columnPageCount]);
  useEffect(() => {
    if (
      sortKey !== "__label__" &&
      sortKey !== "__total__" &&
      !pivot.columnKeys.includes(sortKey)
    ) {
      setSortKey("__total__");
      setSortDirection("desc");
    }
  }, [pivot.columnKeys, sortKey]);
  const expandableKeys = useMemo(() => {
    const keys: string[] = [];
    const collect = (nodes: PivotTreeNode[]) => {
      for (const node of nodes) {
        if (node.children.length > 0) keys.push(node.key);
        collect(node.children);
      }
    };
    collect(pivot.rowTree);
    return keys;
  }, [pivot.rowTree]);

  const addToZone = (event: React.DragEvent, zone: "rows" | "columns") => {
    event.preventDefault();
    const dimension = event.dataTransfer.getData("text/dimension") as Dimension;
    if (!DIMENSIONS.includes(dimension)) return;
    setRows((current) =>
      zone === "rows"
        ? [...current.filter((item) => item !== dimension), dimension]
        : current.filter((item) => item !== dimension),
    );
    setColumns((current) =>
      zone === "columns"
        ? [...current.filter((item) => item !== dimension), dimension]
        : current.filter((item) => item !== dimension),
    );
  };

  const move = (
    zone: "rows" | "columns",
    dimension: Dimension,
    offset: number,
  ) => {
    const update = (current: Dimension[]) => {
      const index = current.indexOf(dimension);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const currentDimension = next[index];
      const targetDimension = next[target];
      if (!currentDimension || !targetDimension) return current;
      next[index] = targetDimension;
      next[target] = currentDimension;
      return next;
    };
    if (zone === "rows") {
      setRows(update);
    } else {
      setColumns(update);
    }
  };
  const chooseSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection(key === "__label__" ? "asc" : "desc");
    }
  };
  const cellText = (cellValue: number) =>
    cellValue === 0 && !showZeros ? "—" : formatNumber(cellValue);
  const heatStyle = (cellValue: number) =>
    ({
      "--heat": Math.min(1, cellValue / maxVisibleValue),
    }) as React.CSSProperties;

  return (
    <section className="panel pivot-panel" id="pivot-workspace">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Build a table</span>
          <h2>Pivot workspace</h2>
          <p>Drag dimensions into rows and columns to reshape the view.</p>
        </div>
        <div className="pivot-heading-actions">
          <SelectionToolbar
            active={selectionActive}
            count={pendingChangeCount}
            onApply={onApplySelection}
            onCancel={onCancelSelection}
            fields={selectionFields}
            onSelectValues={onSelectValues}
          />
          <label className="value-picker">
            <span>Row layout</span>
            <select
              value={rowLayout}
              onChange={(event) =>
                setRowLayout(event.target.value as "compact" | "tabular")
              }
            >
              <option value="compact">Compact hierarchy</option>
              <option value="tabular">Tabular columns</option>
            </select>
          </label>
          <label className="value-picker">
            <span>Measure</span>
            <select
              value={value}
              onChange={(event) => setValue(event.target.value as PivotValue)}
            >
              <option value="usage">MCP calls</option>
              <option value="uniqueUsers">Unique users</option>
            </select>
          </label>
          <button
            className="secondary-button collapse-button"
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            aria-expanded={!collapsed}
            aria-controls="pivot-builder"
          >
            <Icon name="chevron" size={15} />
            {collapsed ? "Show fields" : "Hide fields"}
          </button>
        </div>
      </div>

      <div id="pivot-content">
        {!collapsed && (
          <div className="pivot-builder" id="pivot-builder">
            <div className="field-library">
              <span className="drop-label">Fields</span>
              <div className="dimension-list">
                {DIMENSIONS.filter((dimension) => !used.has(dimension)).map(
                  (dimension) => (
                    <DimensionChip
                      key={dimension}
                      dimension={dimension}
                      onActivate={() =>
                        setRows((current) => [...current, dimension])
                      }
                      onAddToColumns={() =>
                        setColumns((current) => [...current, dimension])
                      }
                    />
                  ),
                )}
                {used.size === DIMENSIONS.length && (
                  <span className="all-fields-used">All fields placed</span>
                )}
              </div>
            </div>
            {(["rows", "columns"] as const).map((zone) => {
              const dimensions = zone === "rows" ? rows : columns;
              return (
                <div
                  key={zone}
                  className="drop-zone"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => addToZone(event, zone)}
                >
                  <span className="drop-label">{zone}</span>
                  <div className="dimension-list">
                    {dimensions.map((dimension, index) => (
                      <DimensionChip
                        key={dimension}
                        dimension={dimension}
                        onRemove={() =>
                          zone === "rows"
                            ? setRows((current) =>
                                current.filter((item) => item !== dimension),
                              )
                            : setColumns((current) =>
                                current.filter((item) => item !== dimension),
                              )
                        }
                        onMove={(offset) => move(zone, dimension, offset)}
                        onMoveZone={() => {
                          if (zone === "rows") {
                            setRows((current) =>
                              current.filter((item) => item !== dimension),
                            );
                            setColumns((current) => [...current, dimension]);
                          } else {
                            setColumns((current) =>
                              current.filter((item) => item !== dimension),
                            );
                            setRows((current) => [...current, dimension]);
                          }
                        }}
                        moveZoneLabel={`Move ${DIMENSION_LABELS[dimension]} to ${
                          zone === "rows" ? "columns" : "rows"
                        }`}
                        canMoveLeft={index > 0}
                        canMoveRight={index < dimensions.length - 1}
                      />
                    ))}
                    {dimensions.length === 0 && (
                      <span className="drop-placeholder">
                        Drop a field here
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="pivot-meta-row">
          <div className="pivot-meta">
            <span>{formatNumber(records.length)} source records</span>
            <span className="meta-dot" />
            <span>{formatNumber(pivot.grandTotal)} total</span>
            <span className="meta-dot" />
            <span>
              Showing{" "}
              {rowLayout === "compact"
                ? visibleCompactRows.length
                : visibleRows.length}{" "}
              of {rowCount} visible rows ({pivot.rowKeys.length} leaf groups)
              and {visibleColumns.length} of {pivot.columnKeys.length} columns
            </span>
            {(rows.includes("group") || columns.includes("group")) && (
              <>
                <span className="meta-dot" />
                <span className="pivot-overlap-note">
                  Group memberships may overlap; group totals are not additive
                </span>
              </>
            )}
          </div>
          <div className="pivot-sort-controls">
            <label>
              <span>Sort by</span>
              <select
                value={sortKey}
                onChange={(event) => {
                  const key = event.target.value;
                  setSortKey(key);
                  setSortDirection(key === "__label__" ? "asc" : "desc");
                }}
              >
                <option value="__total__">Total</option>
                <option value="__label__">Row label</option>
                {pivot.columnKeys.map((column) => (
                  <option key={column} value={column}>
                    {pivot.columnLabels.get(column) ?? ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="sort-direction"
              onClick={() =>
                setSortDirection((direction) =>
                  direction === "asc" ? "desc" : "asc",
                )
              }
              aria-label={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`}
              title={`Currently ${sortDirection === "asc" ? "ascending" : "descending"}`}
            >
              {sortDirection === "asc" ? "↑" : "↓"}
            </button>
            <label className="zero-toggle">
              <input
                type="checkbox"
                checked={showZeros}
                onChange={(event) => setShowZeros(event.target.checked)}
              />
              Show zeros
            </label>
          </div>
          {rowLayout === "compact" && expandableKeys.length > 0 && (
            <div className="pivot-tree-controls">
              <button
                type="button"
                onClick={() => setExpandedKeys(new Set(expandableKeys))}
              >
                Expand all
              </button>
              <button type="button" onClick={() => setExpandedKeys(new Set())}>
                Collapse all
              </button>
            </div>
          )}
          {(rowPageCount > 1 || columnPageCount > 1) && (
            <div className="pivot-pagination">
              <span className="sr-only" role="status" aria-live="polite">
                Pivot rows page {rowPage + 1} of {rowPageCount}; columns page{" "}
                {columnPage + 1} of {columnPageCount}
              </span>
              {rowPageCount > 1 && (
                <span>
                  Rows
                  <button
                    type="button"
                    disabled={rowPage === 0}
                    onClick={() => setRowPage((page) => page - 1)}
                    aria-label="Previous pivot rows"
                  >
                    ‹
                  </button>
                  {rowPage + 1}/{rowPageCount}
                  <button
                    type="button"
                    disabled={rowPage >= rowPageCount - 1}
                    onClick={() => setRowPage((page) => page + 1)}
                    aria-label="Next pivot rows"
                  >
                    ›
                  </button>
                </span>
              )}
              {columnPageCount > 1 && (
                <span>
                  Columns
                  <button
                    type="button"
                    disabled={columnPage === 0}
                    onClick={() => setColumnPage((page) => page - 1)}
                    aria-label="Previous pivot columns"
                  >
                    ‹
                  </button>
                  {columnPage + 1}/{columnPageCount}
                  <button
                    type="button"
                    disabled={columnPage >= columnPageCount - 1}
                    onClick={() => setColumnPage((page) => page + 1)}
                    aria-label="Next pivot columns"
                  >
                    ›
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
        <div
          className="pivot-table-wrap"
          role="region"
          aria-label="Pivot results, horizontally scrollable when needed. Press Enter, then use arrow keys to navigate row controls."
          tabIndex={0}
          onKeyDown={(event) => {
            const controls = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                ".pivot-dimension-select, .tree-caret-button",
              ),
            ];
            if (controls.length === 0) return;
            if (
              event.target === event.currentTarget &&
              (event.key === "Enter" || event.key === "ArrowDown")
            ) {
              event.preventDefault();
              controls[0]?.focus();
              return;
            }
            const index = controls.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            let nextIndex: number;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              nextIndex = Math.min(index + 1, controls.length - 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              nextIndex = Math.max(index - 1, 0);
            } else if (event.key === "Home") {
              nextIndex = 0;
            } else if (event.key === "End") {
              nextIndex = controls.length - 1;
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.focus();
              return;
            } else {
              return;
            }
            event.preventDefault();
            controls[nextIndex]?.focus();
          }}
        >
          {pivot.rowKeys.length === 0 ? (
            <div
              className="chart-empty"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              No data matches the current filters
            </div>
          ) : (
            <table className="pivot-table">
              <thead>
                <tr>
                  {rowLayout === "compact" ? (
                    <th
                      className="row-dimension hierarchy-column"
                      aria-sort={
                        sortKey === "__label__"
                          ? sortDirection === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      <div className="pivot-header-controls">
                        <button
                          type="button"
                          className="sort-header"
                          onClick={() => chooseSort("__label__")}
                        >
                          {pivot.rowHeaders.join(" › ")}
                          <span>
                            {sortKey === "__label__"
                              ? sortDirection === "asc"
                                ? "↑"
                                : "↓"
                              : "↕"}
                          </span>
                        </button>
                        <span className="pivot-header-filters">
                          {rows.map((dimension) => (
                            <PivotHeaderFilter
                              key={dimension}
                              dimension={dimension}
                              selectedFilters={selectedFilters}
                              selectionOptions={selectionOptions}
                              lockedFields={lockedFields}
                              onCommitSelection={onCommitSelection}
                              onToggleLock={onToggleLock}
                            />
                          ))}
                        </span>
                      </div>
                    </th>
                  ) : (
                    rows.map((dimension, index) => (
                      <th
                        className="row-dimension"
                        key={dimension}
                        style={{ left: `${index * 190}px` }}
                        aria-sort={
                          index === 0 && sortKey === "__label__"
                            ? sortDirection === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                      >
                        <div className="pivot-header-controls">
                          <button
                            type="button"
                            className="sort-header"
                            onClick={() => chooseSort("__label__")}
                          >
                            {pivot.rowHeaders[index] ??
                              DIMENSION_LABELS[dimension]}
                            <span>
                              {sortKey === "__label__"
                                ? sortDirection === "asc"
                                  ? "↑"
                                  : "↓"
                                : "↕"}
                            </span>
                          </button>
                          <PivotHeaderFilter
                            dimension={dimension}
                            selectedFilters={selectedFilters}
                            selectionOptions={selectionOptions}
                            lockedFields={lockedFields}
                            onCommitSelection={onCommitSelection}
                            onToggleLock={onToggleLock}
                          />
                        </div>
                      </th>
                    ))
                  )}
                  {visibleColumns.map((column, columnIndex) => (
                    <th
                      key={column}
                      aria-sort={
                        sortKey === column
                          ? sortDirection === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      <div className="pivot-column-heading">
                        <div className="pivot-column-dimensions">
                          {columns.length === 0 ? (
                            <span className="pivot-all-column">All</span>
                          ) : (
                            (pivot.columnValues.get(column) ?? []).map(
                              (label, index) => {
                                const dimension = columns[index];
                                return (
                                  <PivotDimensionValue
                                    key={`${column}-${index}`}
                                    dimension={dimension}
                                    label={label}
                                    selectionValue={
                                      dimension
                                        ? selectionValueFor(dimension, label)
                                        : label
                                    }
                                    selectedFilters={selectedFilters}
                                    onToggleSelection={onToggleSelection}
                                    showSelection={selectionActive}
                                  />
                                );
                              },
                            )
                          )}
                        </div>
                        {columnIndex === 0 && columns.length > 0 && (
                          <span className="pivot-header-filters">
                            {columns.map((dimension) => (
                              <PivotHeaderFilter
                                key={dimension}
                                dimension={dimension}
                                selectedFilters={selectedFilters}
                                selectionOptions={selectionOptions}
                                lockedFields={lockedFields}
                                onCommitSelection={onCommitSelection}
                                onToggleLock={onToggleLock}
                              />
                            ))}
                          </span>
                        )}
                        <button
                          type="button"
                          className="pivot-column-sort"
                          onClick={() => chooseSort(column)}
                          aria-label={`Sort by ${pivot.columnLabels.get(column) ?? ""}`}
                        >
                          {sortKey === column
                            ? sortDirection === "asc"
                              ? "↑"
                              : "↓"
                            : "↕"}
                        </button>
                      </div>
                    </th>
                  ))}
                  <th
                    className="pivot-total-column"
                    aria-sort={
                      sortKey === "__total__"
                        ? sortDirection === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="sort-header numeric"
                      onClick={() => chooseSort("__total__")}
                    >
                      Total
                      <span>
                        {sortKey === "__total__"
                          ? sortDirection === "asc"
                            ? "↑"
                            : "↓"
                          : "↕"}
                      </span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rowLayout === "compact"
                  ? visibleCompactRows.map((node) => {
                      const expanded = expandedKeys.has(node.key);
                      return (
                        <tr
                          key={node.key}
                          aria-level={node.depth + 1}
                          aria-expanded={
                            node.children.length > 0 ? expanded : undefined
                          }
                          className={`pivot-tree-row depth-${node.depth}`}
                        >
                          <th className="row-dimension hierarchy-column">
                            <div
                              className="pivot-tree-dimension"
                              style={{
                                paddingLeft: `${node.depth * 19 + 8}px`,
                              }}
                            >
                              {node.children.length > 0 ? (
                                <button
                                  type="button"
                                  tabIndex={-1}
                                  className="tree-caret-button"
                                  onClick={() =>
                                    setExpandedKeys((current) => {
                                      const next = new Set(current);
                                      if (expanded) {
                                        next.delete(node.key);
                                      } else {
                                        next.add(node.key);
                                      }
                                      return next;
                                    })
                                  }
                                  onKeyDown={(event) => {
                                    if (
                                      (event.key === "ArrowRight" &&
                                        !expanded) ||
                                      (event.key === "ArrowLeft" && expanded)
                                    ) {
                                      event.preventDefault();
                                      setExpandedKeys((current) => {
                                        const next = new Set(current);
                                        if (expanded) {
                                          next.delete(node.key);
                                        } else {
                                          next.add(node.key);
                                        }
                                        return next;
                                      });
                                    }
                                  }}
                                  aria-label={`${expanded ? "Collapse" : "Expand"} ${node.label}`}
                                >
                                  <span className="tree-caret">›</span>
                                </button>
                              ) : (
                                <span className="tree-caret" />
                              )}
                              <PivotDimensionValue
                                dimension={rows[node.depth]}
                                label={node.label}
                                selectionValue={
                                  rows[node.depth]
                                    ? selectionValueFor(
                                        rows[node.depth],
                                        node.label,
                                      )
                                    : node.label
                                }
                                selectedFilters={selectedFilters}
                                onToggleSelection={onToggleSelection}
                                showSelection={selectionActive}
                              />
                              {node.children.length > 0 && (
                                <small>{node.children.length}</small>
                              )}
                            </div>
                          </th>
                          {visibleColumns.map((column) => {
                            const cellValue = node.values.get(column) ?? 0;
                            return (
                              <td
                                className="metric-cell"
                                key={column}
                                style={heatStyle(cellValue)}
                              >
                                {cellText(cellValue)}
                              </td>
                            );
                          })}
                          <td
                            className="metric-cell pivot-total-column"
                            style={heatStyle(node.total)}
                          >
                            {cellText(node.total)}
                          </td>
                        </tr>
                      );
                    })
                  : visibleRows.map((row) => (
                      <tr key={row}>
                        {(
                          pivot.rowValues.get(row) ?? [
                            pivot.rowLabels.get(row) ?? "",
                          ]
                        ).map((rowValue, index) => (
                          <th
                            className="row-dimension"
                            key={`${row}-${index}`}
                            style={{ left: `${index * 190}px` }}
                          >
                            <PivotDimensionValue
                              dimension={rows[index]}
                              label={rowValue}
                              selectionValue={
                                rows[index]
                                  ? selectionValueFor(rows[index], rowValue)
                                  : rowValue
                              }
                              selectedFilters={selectedFilters}
                              onToggleSelection={onToggleSelection}
                              showSelection={selectionActive}
                            />
                          </th>
                        ))}
                        {visibleColumns.map((column) => {
                          const cellValue =
                            pivot.values.get(pivotCellKey(row, column)) ?? 0;
                          return (
                            <td
                              className="metric-cell"
                              key={column}
                              style={heatStyle(cellValue)}
                            >
                              {cellText(cellValue)}
                            </td>
                          );
                        })}
                        <td
                          className="metric-cell pivot-total-column"
                          style={heatStyle(pivot.rowTotals.get(row) ?? 0)}
                        >
                          {cellText(pivot.rowTotals.get(row) ?? 0)}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
});
