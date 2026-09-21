import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { McpRecord } from "../../contracts/mcp-response";
import { formatNumber } from "../analytics/activity-metrics";
import { recordMatchesQuery } from "./filter-model";
import { Icon } from "../interface/icon";
import { McpServerLabel } from "../relationships/mcp-server-label";

interface SearchItem {
  id: string;
  type: "User" | "MCP" | "Tool" | "Group";
  label: string;
  value: string;
  detail: string;
  usage: number;
}

function encodeDomIdSegment(value: string): string {
  let encoded = "u";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function optionDomId(resultsId: string, itemId: string): string {
  return `${resultsId}-${encodeDomIdSegment(itemId)}`;
}

export interface SearchSelection {
  type: SearchItem["type"];
  label: string;
  value: string;
}

function buildSearchItems(records: McpRecord[]): SearchItem[] {
  const users = new Map<
    string,
    { name: string; email: string; usage: number }
  >();
  const servers = new Map<string, number>();
  const tools = new Map<string, { usage: number; servers: Set<string> }>();
  const groups = new Map<string, { usage: number; users: Set<string> }>();

  for (const record of records) {
    const user = users.get(record.email) ?? {
      name: record.displayName,
      email: record.email,
      usage: 0,
    };
    user.usage += record.usage;
    users.set(record.email, user);
    servers.set(
      record.server,
      (servers.get(record.server) ?? 0) + record.usage,
    );
    const tool = tools.get(record.tool) ?? {
      usage: 0,
      servers: new Set<string>(),
    };
    tool.usage += record.usage;
    tool.servers.add(record.server);
    tools.set(record.tool, tool);
    for (const groupName of record.directoryGroups ?? []) {
      const group = groups.get(groupName) ?? {
        usage: 0,
        users: new Set<string>(),
      };
      group.usage += record.usage;
      group.users.add(record.email);
      groups.set(groupName, group);
    }
  }

  return [
    ...[...users.values()].map((user) => ({
      id: `user:${user.email}`,
      type: "User" as const,
      label: user.name,
      value: user.email,
      detail: user.email,
      usage: user.usage,
    })),
    ...[...servers].map(([server, usage]) => ({
      id: `server:${server}`,
      type: "MCP" as const,
      label: server,
      value: server,
      detail: `${formatNumber(usage)} calls`,
      usage,
    })),
    ...[...tools].map(([tool, value]) => ({
      id: `tool:${tool}`,
      type: "Tool" as const,
      label: tool,
      value: tool,
      detail: `${value.servers.size} MCP${value.servers.size === 1 ? "" : "s"}`,
      usage: value.usage,
    })),
    ...[...groups].map(([group, value]) => ({
      id: `group:${group}`,
      type: "Group" as const,
      label: group,
      value: group,
      detail: `${value.users.size} users`,
      usage: value.usage,
    })),
  ];
}

export function GlobalSearch({
  records,
  value,
  onChange,
  onSelect,
  openRequest = 0,
  shortcutEnabled = false,
}: {
  records: McpRecord[];
  value: string;
  onChange: (value: string) => void;
  onSelect?: (selection: SearchSelection) => void;
  openRequest?: number;
  shortcutEnabled?: boolean;
}) {
  const searchId = encodeDomIdSegment(useId());
  const resultsId = `global-search-results-${searchId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressNextFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [resultsStyle, setResultsStyle] = useState<CSSProperties>();
  const items = useMemo(() => buildSearchItems(records), [records]);
  const query = value.trim().toLowerCase();
  const matchingItems = useMemo(
    () =>
      query
        ? items.filter((item) =>
            `${item.label} ${item.value}`.toLowerCase().includes(query),
          )
        : items,
    [items, query],
  );
  const matchingRecordCount = useMemo(
    () =>
      query
        ? records.filter((record) => recordMatchesQuery(record, query)).length
        : records.length,
    [query, records],
  );
  const results = useMemo(() => {
    return (["User", "MCP", "Tool", "Group"] as const).flatMap((type) =>
      matchingItems
        .filter((item) => item.type === type)
        .sort((a, b) => b.usage - a.usage || a.label.localeCompare(b.label))
        .slice(0, query ? 6 : 4),
    );
  }, [matchingItems, query]);
  const positionResults = () => {
    if (!rootRef.current) return;
    const bounds = rootRef.current.getBoundingClientRect();
    const viewportPadding = 12;
    const width = Math.min(500, window.innerWidth - viewportPadding * 2);
    const spaceAbove = Math.max(160, bounds.top - viewportPadding);
    const spaceBelow = Math.max(
      160,
      window.innerHeight - bounds.bottom - viewportPadding,
    );
    const openUp = spaceAbove > spaceBelow;
    const left = Math.max(
      viewportPadding,
      Math.min(
        bounds.right - width,
        window.innerWidth - width - viewportPadding,
      ),
    );
    const maxHeight = Math.min(620, openUp ? spaceAbove - 8 : spaceBelow - 8);
    setResultsStyle({
      position: "fixed",
      width: `${width}px`,
      left: `${left}px`,
      right: "auto",
      top: openUp ? "auto" : `${bounds.bottom + 8}px`,
      bottom: openUp ? `${window.innerHeight - bounds.top + 8}px` : "auto",
      maxHeight: `${maxHeight}px`,
    });
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        positionResults();
        setOpen(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    if (shortcutEnabled) document.addEventListener("keydown", onShortcut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onShortcut);
    };
  }, [shortcutEnabled]);

  useEffect(() => {
    if (!openRequest) return;
    suppressNextFocusRef.current = false;
    inputRef.current?.focus();
    positionResults();
    setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => positionResults();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const choose = (item: SearchItem) => {
    if (onSelect) {
      onSelect({ type: item.type, label: item.label, value: item.value });
      onChange("");
    } else {
      onChange(item.value);
    }
    setOpen(false);
    suppressNextFocusRef.current = true;
    inputRef.current?.focus();
  };
  return (
    <div className="global-search" ref={rootRef}>
      <div className={`search-control ${open ? "open" : ""}`}>
        <Icon name="search" size={17} />
        <input
          ref={inputRef}
          type="search"
          placeholder="Search users, MCPs, tools, groups…"
          value={value}
          role="combobox"
          aria-label="Search users, MCPs, tools, and groups"
          aria-expanded={open}
          aria-controls={resultsId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && results[activeIndex]
              ? optionDomId(resultsId, results[activeIndex].id)
              : undefined
          }
          onFocus={() => {
            if (suppressNextFocusRef.current) {
              suppressNextFocusRef.current = false;
              return;
            }
            positionResults();
            setOpen(true);
          }}
          onChange={(event) => {
            onChange(event.target.value);
            setActiveIndex(0);
            positionResults();
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) =>
                Math.min(index + 1, Math.max(results.length - 1, 0)),
              );
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            }
            if (event.key === "Enter" && open && results[activeIndex]) {
              event.preventDefault();
              choose(results[activeIndex]);
            } else if (event.key === "Enter" && query) {
              event.preventDefault();
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
        />
        {value ? (
          <button
            type="button"
            className="search-clear"
            onClick={() => onChange("")}
            aria-label="Clear global search"
          >
            ×
          </button>
        ) : shortcutEnabled ? (
          <kbd aria-label="Keyboard shortcut: Control or Command K">
            Ctrl/⌘ K
          </kbd>
        ) : null}
      </div>
      {open && (
        <div className="search-results" style={resultsStyle}>
          <div className="search-results-header">
            <span>Search across the organization</span>
            <span>{items.length.toLocaleString()} searchable items</span>
          </div>
          {query && (
            <div className="search-apply-hint" role="status">
              <span className="search-apply-icon">
                <Icon name="search" size={15} />
              </span>
              <span>
                <strong>Filtering activity by “{value.trim()}”</strong>
                <small>
                  {matchingRecordCount.toLocaleString()} activity rows ·{" "}
                  {matchingItems.length.toLocaleString()} matching users, MCPs,
                  tools, and groups
                </small>
              </span>
              <kbd>↵</kbd>
            </div>
          )}
          {results.length === 0 && (
            <div className="search-no-results" role="status" aria-live="polite">
              No users, MCPs, tools, or groups match “{value}”
            </div>
          )}
          <div id={resultsId} role="listbox" aria-label="Global search results">
            {results.length > 0 &&
              (["User", "MCP", "Tool", "Group"] as const).map((type) => {
                const typeResults = results.filter(
                  (item) => item.type === type,
                );
                if (typeResults.length === 0) return null;
                return (
                  <div
                    className="search-result-group"
                    role="group"
                    aria-label={`${type}s`}
                    key={type}
                  >
                    <span className="search-result-label" aria-hidden="true">
                      {type}s
                    </span>
                    {typeResults.map((item) => {
                      const index = results.indexOf(item);
                      return (
                        <button
                          type="button"
                          id={optionDomId(resultsId, item.id)}
                          role="option"
                          aria-selected={index === activeIndex}
                          aria-label={`${type} ${item.label}, ${formatNumber(item.usage)} calls, select exact match`}
                          tabIndex={-1}
                          className={index === activeIndex ? "active" : ""}
                          key={item.id}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => choose(item)}
                        >
                          <span
                            className={`search-result-icon ${type.toLowerCase()}`}
                          >
                            <Icon
                              name={
                                type === "User"
                                  ? "users"
                                  : type === "MCP"
                                    ? "server"
                                    : type === "Tool"
                                      ? "tools"
                                      : "grid"
                              }
                              size={15}
                            />
                          </span>
                          <span className="search-result-main">
                            <strong>
                              {type === "MCP" ? (
                                <McpServerLabel server={item.label} />
                              ) : (
                                item.label
                              )}
                            </strong>
                            <small>{item.detail}</small>
                          </span>
                          <span className="search-result-usage">
                            {formatNumber(item.usage)} calls
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
          </div>
          <div className="search-results-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> navigate
            </span>
            <span>
              <kbd>↵</kbd> select highlighted result
            </span>
            <span>Text filters as you type</span>
            <span>
              <kbd>esc</kbd> close
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
