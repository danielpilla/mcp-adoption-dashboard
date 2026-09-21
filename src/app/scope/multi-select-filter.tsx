import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ASSOCIATION_STATE_ORDER,
  type AssociationState,
} from "./associative-model";
import { Icon } from "../interface/icon";
import { SelectionToolbar } from "./selection-toolbar";
import {
  sameSelection,
  valuesForAssociationAction,
  type AssociationSelectionAction,
} from "./selection-model";

export interface FilterOption {
  value: string;
  label: string;
  detail?: string;
  badge?: string;
  state?: AssociationState;
  count?: number;
  usage?: number;
}

export function MultiSelectFilter({
  label,
  kind,
  options,
  selected,
  onChange,
  locked = false,
  onToggleLock,
  compact = false,
  menuAlign = "right",
  openRequest = 0,
  triggerTabIndex,
}: {
  label: string;
  kind: "users" | "server" | "tools" | "grid" | "calendar";
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  locked?: boolean;
  onToggleLock?: () => void;
  compact?: boolean;
  menuAlign?: "left" | "right";
  openRequest?: number;
  triggerTabIndex?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [selectionDirty, setSelectionDirty] = useState(false);
  const baselineRef = useRef<string[]>(selected);
  const [draftSelected, setDraftSelected] = useState<string[]>(selected);
  const [placementUp, setPlacementUp] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState(620);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const [query, setQuery] = useState("");
  const [showExcluded, setShowExcluded] = useState(true);
  const [sortMode, setSortMode] = useState<"association" | "az" | "za">(
    "association",
  );
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const handledOpenRequestRef = useRef(0);
  const activeSelected = open ? draftSelected : selected;
  const selectedSet = useMemo(() => new Set(activeSelected), [activeSelected]);
  const filteredOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return options
      .filter(
        (option) =>
          (showExcluded || option.state !== "excluded") &&
          (!needle ||
            `${option.label} ${option.detail ?? ""}`
              .toLowerCase()
              .includes(needle)),
      )
      .sort((a, b) => {
        if (sortMode === "az") return a.label.localeCompare(b.label);
        if (sortMode === "za") return b.label.localeCompare(a.label);
        const stateDifference =
          ASSOCIATION_STATE_ORDER.indexOf(a.state ?? "possible") -
          ASSOCIATION_STATE_ORDER.indexOf(b.state ?? "possible");
        return (
          stateDifference ||
          (b.usage ?? 0) - (a.usage ?? 0) ||
          a.label.localeCompare(b.label)
        );
      });
  }, [options, query, showExcluded, sortMode]);
  const visibleOptions = filteredOptions.slice(0, 100);
  const associationCounts = useMemo(
    () =>
      options.reduce(
        (counts, option) => {
          counts[option.state ?? "possible"] += 1;
          return counts;
        },
        {
          selected: 0,
          selectedExcluded: 0,
          possible: 0,
          alternative: 0,
          excluded: 0,
        } as Record<AssociationState, number>,
      ),
    [options],
  );
  const pendingChangeCount = (() => {
    const baseline = new Set(baselineRef.current);
    const current = new Set(draftSelected);
    return (
      baselineRef.current.filter((value) => !current.has(value)).length +
      draftSelected.filter((value) => !baseline.has(value)).length
    );
  })();

  const applySelection = useCallback(
    (restoreFocus = true) => {
      if (selectionDirty) onChange([...draftSelected]);
      baselineRef.current = [...draftSelected];
      setSelectionDirty(false);
      setOpen(false);
      if (restoreFocus) {
        window.setTimeout(() => triggerRef.current?.focus());
      }
    },
    [draftSelected, onChange, selectionDirty],
  );
  const cancelSelection = useCallback(() => {
    setDraftSelected([...baselineRef.current]);
    setSelectionDirty(false);
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus());
  }, []);
  const previewSelection = (values: string[]) => {
    if (locked) return;
    setDraftSelected(values);
    setSelectionDirty(!sameSelection(values, baselineRef.current));
  };
  const runAssociationAction = (action: AssociationSelectionAction) => {
    if (locked) return;
    previewSelection(valuesForAssociationAction(options, action));
  };
  const positionMenu = useCallback(() => {
    if (!rootRef.current) return;
    const bounds = rootRef.current.getBoundingClientRect();
    const viewportPadding = 12;
    const menuWidth = Math.min(340, window.innerWidth - viewportPadding * 2);
    const temporalMenu = rootRef.current.closest(".temporal-group-menu");
    if (temporalMenu) {
      const parentBounds = temporalMenu.getBoundingClientRect();
      const rightSpace =
        window.innerWidth - parentBounds.right - viewportPadding;
      const leftSpace = parentBounds.left - viewportPadding;
      const left =
        rightSpace >= menuWidth + 8
          ? parentBounds.right + 8
          : leftSpace >= menuWidth + 8
            ? parentBounds.left - menuWidth - 8
            : window.innerWidth - menuWidth - viewportPadding;
      const top = Math.max(
        viewportPadding,
        Math.min(parentBounds.top, window.innerHeight - viewportPadding - 180),
      );
      const availableHeight = Math.min(
        620,
        window.innerHeight - top - viewportPadding,
      );
      setPlacementUp(false);
      setMenuMaxHeight(availableHeight);
      setMenuStyle({
        position: "fixed",
        width: `${menuWidth}px`,
        left: `${Math.max(viewportPadding, left)}px`,
        right: "auto",
        top: `${top}px`,
        bottom: "auto",
        maxHeight: `${availableHeight}px`,
      });
      return;
    }
    const spaceAbove = Math.max(120, bounds.top - viewportPadding);
    const spaceBelow = Math.max(
      120,
      window.innerHeight - bounds.bottom - viewportPadding,
    );
    const openUp = spaceAbove > spaceBelow;
    const left = Math.max(
      viewportPadding,
      Math.min(
        menuAlign === "left" ? bounds.left : bounds.right - menuWidth,
        window.innerWidth - menuWidth - viewportPadding,
      ),
    );
    const availableHeight = Math.min(
      620,
      openUp ? spaceAbove - 8 : spaceBelow - 8,
    );
    setPlacementUp(openUp);
    setMenuMaxHeight(availableHeight);
    setMenuStyle({
      position: "fixed",
      width: `${menuWidth}px`,
      left: `${left}px`,
      right: "auto",
      top: openUp ? "auto" : `${bounds.bottom + 8}px`,
      bottom: openUp ? `${window.innerHeight - bounds.top + 8}px` : "auto",
      maxHeight: `${availableHeight}px`,
    });
  }, [menuAlign]);
  const openSelection = () => {
    if (open) {
      applySelection();
      return;
    }
    baselineRef.current = [...selected];
    setDraftSelected([...selected]);
    setSelectionDirty(false);
    positionMenu();
    setOpen(true);
  };

  useEffect(() => {
    if (!openRequest || handledOpenRequestRef.current === openRequest) return;
    handledOpenRequestRef.current = openRequest;
    baselineRef.current = [...selected];
    setDraftSelected([...selected]);
    setSelectionDirty(false);
    positionMenu();
    setOpen(true);
  }, [openRequest, positionMenu, selected]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => positionMenu();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, positionMenu]);

  useEffect(() => {
    setActiveOptionIndex((index) =>
      Math.max(0, Math.min(index, visibleOptions.length - 1)),
    );
  }, [visibleOptions.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        applySelection(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches(
          "button, a, input, textarea, select, [contenteditable='true']",
        )
      ) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          cancelSelection();
        }
        return;
      }
      if (event.key === "Enter" && selectionDirty) {
        event.preventDefault();
        event.stopImmediatePropagation();
        applySelection();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelSelection();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [applySelection, cancelSelection, open, selectionDirty]);

  const toggle = (value: string) => {
    previewSelection(
      selectedSet.has(value)
        ? activeSelected.filter((item) => item !== value)
        : [...activeSelected, value],
    );
  };

  return (
    <div className={`multi-filter${compact ? " compact" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        tabIndex={triggerTabIndex}
        className={`multi-filter-trigger${compact ? " compact" : ""} ${selected.length ? "active" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={compact ? `Filter ${label}` : undefined}
        onClick={openSelection}
      >
        <Icon name={compact ? "filter" : kind} size={15} />
        <span className={compact ? "sr-only" : undefined}>{label}</span>
        {locked && (
          <span className="multi-filter-lock" aria-label="Locked">
            <Icon name="lock" size={12} />
          </span>
        )}
        {selected.length > 0 && (
          <strong aria-label={`${selected.length} selected`}>
            {selected.length}
          </strong>
        )}
        {!compact &&
          selected.length === 0 &&
          options.some((option) => option.state) && (
            <small className="multi-filter-possible">
              {associationCounts.possible}
            </small>
          )}
        {!compact && <span className="multi-filter-caret">⌄</span>}
        {!compact && options.some((option) => option.state) && (
          <span className="association-state-bar" aria-hidden="true">
            <i
              className="selected"
              style={{
                flex:
                  associationCounts.selected +
                  associationCounts.selectedExcluded,
              }}
            />
            <i
              className="possible"
              style={{ flex: associationCounts.possible }}
            />
            <i
              className="alternative"
              style={{ flex: associationCounts.alternative }}
            />
            <i
              className="excluded"
              style={{ flex: associationCounts.excluded }}
            />
          </span>
        )}
      </button>
      {open && (
        <div
          className={`multi-filter-menu${compact && placementUp ? " placement-up" : ""}${menuAlign === "left" ? " align-left" : ""}`}
          style={menuStyle ?? { maxHeight: `${menuMaxHeight}px` }}
        >
          <div className="multi-filter-head">
            <div>
              <strong>{label}</strong>
              <span>Select one or more</span>
            </div>
            <div className="multi-filter-head-actions">
              {draftSelected.length > 0 && !locked && (
                <button type="button" onClick={() => previewSelection([])}>
                  Clear
                </button>
              )}
              {selected.length > 0 && onToggleLock && (
                <button
                  type="button"
                  className={`filter-lock-toggle${locked ? " locked" : ""}`}
                  onClick={onToggleLock}
                  disabled={selectionDirty}
                  aria-label={`${locked ? "Unlock" : "Lock"} ${label} selection`}
                  title={`${locked ? "Unlock" : "Lock"} selection`}
                >
                  <Icon name={locked ? "lock" : "unlock"} size={13} />
                </button>
              )}
            </div>
            {selectionDirty && (
              <SelectionToolbar
                count={pendingChangeCount}
                onApply={applySelection}
                onCancel={cancelSelection}
              />
            )}
          </div>
          <label className="multi-filter-search">
            <Icon name="search" size={15} />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" || visibleOptions.length === 0) {
                  return;
                }
                event.preventDefault();
                setActiveOptionIndex(0);
                optionRefs.current[0]?.focus();
              }}
              placeholder={`Search ${label.toLowerCase()}…`}
              aria-label={`Search ${label}`}
            />
          </label>
          {options.some((option) => option.state) && (
            <>
              <div
                className="association-legend"
                aria-label="Association states"
              >
                <span className="selected">
                  <i /> Selected
                </span>
                {associationCounts.selectedExcluded > 0 && (
                  <span className="selected-excluded">
                    <i /> Selected, unrelated
                  </span>
                )}
                <span className="possible">
                  <i /> Possible
                </span>
                <span className="alternative">
                  <i /> Alternative
                </span>
                <span className="excluded">
                  <i /> Excluded
                </span>
              </div>
              <div
                className="association-actions"
                role="toolbar"
                aria-label={`${label} association selection actions`}
              >
                <button
                  type="button"
                  onClick={() => runAssociationAction("all")}
                  disabled={locked || options.length === 0}
                >
                  Select all <span>{options.length}</span>
                </button>
                <button
                  type="button"
                  onClick={() => runAssociationAction("possible")}
                  disabled={locked || associationCounts.possible === 0}
                >
                  Select possible <span>{associationCounts.possible}</span>
                </button>
                <button
                  type="button"
                  onClick={() => runAssociationAction("alternative")}
                  disabled={locked || associationCounts.alternative === 0}
                >
                  Select alternative{" "}
                  <span>{associationCounts.alternative}</span>
                </button>
                <button
                  type="button"
                  onClick={() => runAssociationAction("excluded")}
                  disabled={locked || associationCounts.excluded === 0}
                >
                  Select excluded <span>{associationCounts.excluded}</span>
                </button>
              </div>
            </>
          )}
          <div className="filter-sort-row">
            <span>Sort by</span>
            <div>
              <button
                type="button"
                className={sortMode === "association" ? "active" : ""}
                aria-pressed={sortMode === "association"}
                onClick={() => setSortMode("association")}
              >
                Associated calls
              </button>
              <button
                type="button"
                className={sortMode === "az" ? "active" : ""}
                aria-pressed={sortMode === "az"}
                onClick={() => setSortMode("az")}
              >
                A–Z
              </button>
              <button
                type="button"
                className={sortMode === "za" ? "active" : ""}
                aria-pressed={sortMode === "za"}
                onClick={() => setSortMode("za")}
              >
                Z–A
              </button>
            </div>
          </div>
          <div
            id={listboxId}
            className="multi-filter-options"
            role="listbox"
            aria-label={`${label} options`}
            aria-multiselectable="true"
          >
            {visibleOptions.length === 0 ? (
              <div className="multi-filter-empty">No matching options</div>
            ) : (
              visibleOptions.map((option, index) => {
                const checked = selectedSet.has(option.value);
                return (
                  <button
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    tabIndex={index === activeOptionIndex ? 0 : -1}
                    className={`${checked ? "selected " : ""}association-${option.state ?? "possible"}`}
                    key={option.value}
                    onFocus={() => setActiveOptionIndex(index)}
                    onKeyDown={(event) => {
                      let nextIndex: number;
                      if (event.key === "ArrowDown") {
                        nextIndex = Math.min(
                          index + 1,
                          visibleOptions.length - 1,
                        );
                      } else if (event.key === "ArrowUp") {
                        nextIndex = Math.max(index - 1, 0);
                      } else if (event.key === "Home") {
                        nextIndex = 0;
                      } else if (event.key === "End") {
                        nextIndex = visibleOptions.length - 1;
                      } else {
                        return;
                      }
                      event.preventDefault();
                      setActiveOptionIndex(nextIndex);
                      optionRefs.current[nextIndex]?.focus();
                    }}
                    onClick={() => toggle(option.value)}
                    disabled={locked}
                  >
                    <span className="filter-check">
                      {checked || option.state === "selectedExcluded"
                        ? "✓"
                        : ""}
                    </span>
                    <span className="filter-option-copy">
                      <span className="filter-option-title">
                        <strong>{option.label}</strong>
                        {option.badge && (
                          <span className="internal-mcp-badge">
                            {option.badge}
                          </span>
                        )}
                      </span>
                      <small>
                        {option.detail ??
                          `Association state: ${option.state ?? "possible"}`}
                      </small>
                    </span>
                    {option.usage !== undefined && (
                      <span className="filter-option-metric">
                        <strong>{option.usage.toLocaleString()}</strong>
                        <small>calls</small>
                      </span>
                    )}
                    <span className="sr-only">
                      Association state: {option.state ?? "possible"}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="multi-filter-footer">
            <span>
              {draftSelected.length} selected · {associationCounts.possible}{" "}
              possible
              {associationCounts.excluded > 0 &&
                ` · ${associationCounts.excluded} excluded`}
            </span>
            {filteredOptions.length > 100 && (
              <span>Refine search to see more</span>
            )}
            {associationCounts.excluded > 0 && (
              <button
                type="button"
                onClick={() => setShowExcluded((current) => !current)}
              >
                {showExcluded ? "Hide excluded" : "Show excluded"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
