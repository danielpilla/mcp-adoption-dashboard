// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssociationOption } from "./scope/associative-model";
import type { Filters, TemporalFilterField } from "./scope/filter-model";
import { GlobalSearch } from "./scope/global-search";
import { McpMomentumPanel } from "./analytics/mcp-momentum-panel";
import type { McpMomentumResult } from "./analytics/mcp-momentum";
import { MultiSelectFilter } from "./scope/multi-select-filter";
import type { SelectionField } from "./scope/selection-model";
import { SelectionToolbar } from "./scope/selection-toolbar";
import { TemporalFilterGroup } from "./scope/temporal-filter-group";
import { TrendChart } from "./analytics/trend-chart";
import { useDialogFocusTrap } from "./interface/dialog-focus-trap";
import type { McpRecord } from "../contracts/mcp-response";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

async function render(element: ReactNode) {
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

async function flushTimers() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        globalThis.window.setTimeout(resolve, 0);
      }),
  );
}

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  globalThis.document.body.replaceChildren();
  vi.restoreAllMocks();
});

function emptyFilters(): Filters {
  return {
    query: "",
    origins: [],
    users: [],
    servers: [],
    tools: [],
    groups: [],
    dates: [],
    days: [],
    weeks: [],
    months: [],
    monthYears: [],
    quarters: [],
    years: [],
  };
}

function temporalOptions(): Record<TemporalFilterField, AssociationOption[]> {
  const empty: AssociationOption[] = [];
  return {
    dates: [
      {
        value: "2026-09-20",
        label: "Sep 20, 2026",
        state: "possible",
        count: 1,
        usage: 1,
      },
    ],
    days: empty,
    weeks: empty,
    months: empty,
    monthYears: empty,
    quarters: empty,
    years: empty,
  };
}

function EmptyDialog() {
  const dialogRef = useDialogFocusTrap<HTMLElement>(true);
  return createElement(
    "div",
    null,
    createElement(
      "section",
      { ref: dialogRef, role: "dialog", tabIndex: -1 },
      "Loading",
    ),
  );
}

function TransitionDialog() {
  const [view, setView] = useState<"form" | "loading">("form");
  const dialogRef = useDialogFocusTrap<HTMLElement>(true, view);
  return createElement(
    "section",
    { ref: dialogRef, role: "dialog", tabIndex: -1 },
    view === "form"
      ? createElement(
          "button",
          { type: "button", onClick: () => setView("loading") },
          "Connect",
        )
      : "Loading",
  );
}

describe("accessibility regressions", () => {
  it("focuses a dialog fallback when it has no interactive controls", async () => {
    const container = await render(createElement(EmptyDialog));
    await flushTimers();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');

    expect(globalThis.document.activeElement).toBe(dialog);
    await act(async () => {
      dialog?.dispatchEvent(
        new globalThis.window.KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
        }),
      );
    });
    expect(globalThis.document.activeElement).toBe(dialog);
  });

  it("refocuses a dialog when loading replaces its focused form", async () => {
    const container = await render(createElement(TransitionDialog));
    await flushTimers();
    const button = container.querySelector<HTMLButtonElement>("button");
    await act(async () => button?.click());
    await flushTimers();

    expect(globalThis.document.activeElement).toBe(
      container.querySelector('[role="dialog"]'),
    );
  });

  it("links a spaced group result to its active descendant", async () => {
    const record: McpRecord = {
      date: "2026-09-20",
      userId: "user-1",
      email: "user@example.com",
      displayName: "Example User",
      server: "example",
      tool: "search",
      usage: 1,
      directoryGroups: ["Pilot Program"],
    };
    const container = await render(
      createElement(GlobalSearch, {
        records: [record],
        value: "Pilot Program",
        onChange: () => undefined,
      }),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    );
    expect(input).not.toBeNull();
    await act(async () => input?.focus());

    const option = container.querySelector<HTMLElement>('[role="option"]');
    const optionId = option?.id;
    expect(optionId).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    expect(input?.getAttribute("aria-activedescendant")).toBe(optionId);
    expect(globalThis.document.getElementById(optionId ?? "")).toBe(option);

    const listbox = container.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox?.querySelector(".search-results-header")).toBeNull();
    expect(
      listbox?.querySelector('[role="group"][aria-label="Groups"]'),
    ).not.toBeNull();
  });

  it("announces an empty global search result", async () => {
    const container = await render(
      createElement(GlobalSearch, {
        records: [],
        value: "missing",
        onChange: () => undefined,
      }),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    );
    await act(async () => input?.focus());

    const emptyState = container.querySelector(".search-no-results");
    expect(emptyState?.getAttribute("role")).toBe("status");
    expect(emptyState?.getAttribute("aria-live")).toBe("polite");
  });

  it("shows a platform-neutral shortcut only when it is enabled", async () => {
    const disabled = await render(
      createElement(GlobalSearch, {
        records: [],
        value: "",
        onChange: () => undefined,
      }),
    );
    const enabled = await render(
      createElement(GlobalSearch, {
        records: [],
        value: "",
        onChange: () => undefined,
        shortcutEnabled: true,
      }),
    );

    expect(disabled.querySelector("kbd")).toBeNull();
    expect(enabled.querySelector("kbd")?.textContent?.trim()).toBe("Ctrl/⌘ K");
  });

  it("registers outside-click handling only while a filter is open", async () => {
    const addListener = vi.spyOn(globalThis.document, "addEventListener");
    const removeListener = vi.spyOn(globalThis.document, "removeEventListener");
    const onChange = vi.fn();
    const container = await render(
      createElement(MultiSelectFilter, {
        label: "Users",
        kind: "users",
        options: [{ value: "user@example.com", label: "Example User" }],
        selected: [],
        onChange,
      }),
    );

    expect(
      addListener.mock.calls.some(([event]) => event === "pointerdown"),
    ).toBe(false);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".multi-filter-trigger")
        ?.click(),
    );
    expect(container.querySelector(".multi-filter-menu")).not.toBeNull();
    expect(
      addListener.mock.calls.some(([event]) => event === "pointerdown"),
    ).toBe(true);

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
    );
    await act(async () => {
      globalThis.document.body.dispatchEvent(
        new globalThis.window.PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(container.querySelector(".multi-filter-menu")).toBeNull();
    expect(onChange).toHaveBeenCalledWith(["user@example.com"]);
    expect(
      removeListener.mock.calls.some(([event]) => event === "pointerdown"),
    ).toBe(true);
  });

  it("keeps every active trend date in the roving focus model", async () => {
    const records: McpRecord[] = Array.from({ length: 60 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1))
        .toISOString()
        .slice(0, 10);
      return {
        date,
        userId: "user-1",
        email: "user@example.com",
        displayName: "Example User",
        server: "example",
        tool: "search",
        usage: index + 1,
      };
    });
    const container = await render(
      createElement(TrendChart, {
        records,
        onToggleDate: () => undefined,
      }),
    );
    const points = [
      ...container.querySelectorAll<SVGCircleElement>(
        ".chart-point.interactive",
      ),
    ];

    expect(points).toHaveLength(records.length);
    expect(points[0].getAttribute("aria-setsize")).toBe(String(records.length));

    points[0].focus();
    await act(async () => {
      points[0].dispatchEvent(
        new globalThis.window.KeyboardEvent("keydown", {
          key: "End",
          bubbles: true,
        }),
      );
    });
    expect(globalThis.document.activeElement).toBe(points.at(-1));
  });

  it("draws zero-activity dates instead of bridging across gaps", async () => {
    const records: McpRecord[] = [
      {
        date: "2026-09-01",
        userId: "user-1",
        email: "user@example.com",
        displayName: "Example User",
        server: "example",
        tool: "search",
        usage: 4,
      },
      {
        date: "2026-09-03",
        userId: "user-1",
        email: "user@example.com",
        displayName: "Example User",
        server: "example",
        tool: "search",
        usage: 2,
      },
    ];
    const container = await render(
      createElement(TrendChart, {
        records,
        startDate: "2026-09-01",
        endDate: "2026-09-03",
      }),
    );
    const path = container.querySelector<SVGPathElement>(".chart-line");
    const commands = path?.getAttribute("d")?.match(/[ML]/g) ?? [];

    expect(commands).toHaveLength(3);
  });

  it("closes only the nested time filter on Escape", async () => {
    const container = await render(
      createElement(TemporalFilterGroup, {
        options: temporalOptions(),
        filters: emptyFilters(),
        onChange: () => undefined,
        lockedFields: new Set<SelectionField>(),
        onToggleLock: () => undefined,
      }),
    );
    const timeTrigger = container.querySelector<HTMLButtonElement>(
      ".temporal-group-trigger",
    );
    expect(timeTrigger).not.toBeNull();
    await act(async () => timeTrigger?.click());

    const dateTrigger = container.querySelector<HTMLButtonElement>(
      ".temporal-subfilters .multi-filter-trigger",
    );
    expect(dateTrigger).not.toBeNull();
    await act(async () => dateTrigger?.click());

    const search = container.querySelector<HTMLInputElement>(
      ".multi-filter-menu input",
    );
    expect(search).not.toBeNull();
    await act(async () => {
      search?.dispatchEvent(
        new globalThis.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    await flushTimers();

    expect(container.querySelector(".multi-filter-menu")).toBeNull();
    expect(container.querySelector(".temporal-group-menu")).not.toBeNull();
    expect(globalThis.document.activeElement).toBe(dateTrigger);

    await act(async () => {
      container.querySelector(".temporal-group-menu")?.dispatchEvent(
        new globalThis.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    await flushTimers();
    expect(container.querySelector(".temporal-group-menu")).toBeNull();
    expect(globalThis.document.activeElement).toBe(timeTrigger);
  });

  it("restores the selection action trigger after closing", async () => {
    const container = await render(
      createElement(SelectionToolbar, {
        active: false,
        count: 0,
        onApply: () => undefined,
        onCancel: () => undefined,
        fields: [
          {
            field: "users",
            label: "User",
            options: [
              {
                value: "user@example.com",
                label: "Example User",
                state: "possible",
                count: 1,
                usage: 1,
              },
            ],
          },
        ],
        onSelectValues: () => undefined,
      }),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      ".selection-actions-trigger",
    );
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());

    await act(async () => {
      container.querySelector(".selection-actions-popover")?.dispatchEvent(
        new globalThis.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    await flushTimers();

    expect(container.querySelector(".selection-actions-popover")).toBeNull();
    expect(globalThis.document.activeElement).toBe(trigger);

    await act(async () => trigger?.click());
    const selectPossible = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".selection-actions-popover button",
      ),
    ].find((button) => button.textContent?.includes("Select possible"));
    expect(selectPossible).not.toBeUndefined();
    await act(async () => selectPossible?.click());
    await flushTimers();

    expect(container.querySelector(".selection-actions-popover")).toBeNull();
    expect(globalThis.document.activeElement).toBe(trigger);
  });

  it("gives momentum lanes and selectable rows complete names", async () => {
    const onToggleServer = vi.fn();
    const result: McpMomentumResult = {
      status: "ready",
      previousPeriod: {
        startDate: "2026-09-01",
        endDate: "2026-09-03",
        days: 3,
      },
      currentPeriod: {
        startDate: "2026-09-04",
        endDate: "2026-09-06",
        days: 3,
      },
      omittedLeadingDate: null,
      increased: [
        {
          server: "github",
          previousCalls: 10,
          currentCalls: 15,
          change: 5,
          percentageChange: 50,
          status: "changed",
        },
      ],
      decreased: [
        {
          server: "slack",
          previousCalls: 8,
          currentCalls: 0,
          change: -8,
          percentageChange: -100,
          status: "inactive",
        },
        {
          server: "notion",
          previousCalls: 10_000,
          currentCalls: 9_999,
          change: -1,
          percentageChange: -0.01,
          status: "changed",
        },
      ],
      unchangedCount: 2,
    };
    const container = await render(
      createElement(McpMomentumPanel, {
        result,
        selectedServers: [],
        onToggleServer,
        selectionActive: false,
        pendingChangeCount: 0,
        onApplySelection: () => undefined,
        onCancelSelection: () => undefined,
        selectionFields: [],
        onSelectValues: () => undefined,
      }),
    );

    const momentumTitle =
      container.querySelector<HTMLHeadingElement>(".momentum-panel h2");
    expect(momentumTitle?.id).toBeTruthy();
    expect(
      container
        .querySelector(".momentum-panel")
        ?.getAttribute("aria-labelledby"),
    ).toBe(momentumTitle?.id);
    expect(container.querySelectorAll(".momentum-list")).toHaveLength(2);
    const github = container.querySelector<HTMLButtonElement>(
      '.momentum-row[aria-label*="github"]',
    );
    expect(github?.getAttribute("aria-label")).toContain(
      "Earlier period 10 calls. Current period 15 calls. +5 · +50%.",
    );
    expect(github?.getAttribute("aria-pressed")).toBe("false");
    expect(
      container
        .querySelector('.momentum-row[aria-label*="notion"]')
        ?.getAttribute("aria-label"),
    ).toContain("−1 · −<0.1%.");
    expect(
      container.querySelector(".momentum-rail")?.getAttribute("aria-hidden"),
    ).toBe("true");
    await act(async () => github?.click());
    expect(onToggleServer).toHaveBeenCalledWith("github");
  });

  it("announces momentum comparison guidance without a result list", async () => {
    const container = await render(
      createElement(McpMomentumPanel, {
        result: {
          status: "disjoint-range",
          availableDays: 6,
        },
        selectedServers: [],
        onToggleServer: () => undefined,
        selectionActive: false,
        pendingChangeCount: 0,
        onApplySelection: () => undefined,
        onCancelSelection: () => undefined,
        selectionFields: [],
        onSelectValues: () => undefined,
      }),
    );
    const state = container.querySelector(".momentum-state");

    expect(state?.getAttribute("role")).toBe("status");
    expect(state?.getAttribute("aria-live")).toBe("polite");
    expect(state?.textContent).toContain("Choose a continuous time span");
    expect(container.querySelector(".momentum-list")).toBeNull();
  });

  it("keeps inventory headers visible until the mobile card breakpoint", () => {
    const stylesDirectory = resolve(process.cwd(), "src/app/styles");
    const css = readdirSync(stylesDirectory)
      .filter((name) => name.endsWith(".css"))
      .sort()
      .map((name) => readFileSync(resolve(stylesDirectory, name), "utf8"))
      .join("\n");

    expect(css).not.toMatch(
      /@media \(max-width: 820px\)\s*\{\s*\.inventory-table thead/,
    );
    expect(css).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.inventory-table thead\s*\{[\s\S]*?clip-path: inset\(50%\)/,
    );
  });
});
