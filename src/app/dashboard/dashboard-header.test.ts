// @vitest-environment jsdom

import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DateRange } from "../../contracts/mcp-response";
import { presetRange } from "./dashboard-dates";
import { DashboardHeader } from "./dashboard-header";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

async function renderHeader(range: DateRange) {
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      createElement(DashboardHeader, {
        activePhase: "dashboard-phase",
        status: { data: null, isSnapshot: false, refreshedAt: "", busy: false },
        range: {
          active: range,
          draft: range,
          startDateInputRef: createRef<HTMLInputElement>(),
          onUpdate: vi.fn(),
        },
        search: {
          records: [],
          value: "",
          filtering: false,
          onChange: vi.fn(),
          onSelect: vi.fn(),
        },
        actions: { onOpenSettings: vi.fn(), onRefresh: vi.fn() },
        children: null,
      }),
    ),
  );
  return container;
}

function pressedPresets(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      ".preset-group button[aria-pressed='true']",
    ),
  ].map((button) => button.textContent ?? "");
}

function customDates(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLInputElement>(
      ".custom-dates input[type='date']",
    ),
  ].map((input) => input.value);
}

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  globalThis.document.body.replaceChildren();
});

describe("dashboard header range presets", () => {
  it.each([7, 30, 90])("highlights the %i-day preset", async (days) => {
    const container = await renderHeader(presetRange(days));
    expect(pressedPresets(container)).toEqual([`${days}D`]);
  });

  it("shows a non-preset initial range as a custom range", async () => {
    const range = presetRange(14);
    const container = await renderHeader(range);
    expect(pressedPresets(container)).toEqual([]);
    expect(customDates(container)).toEqual([range.startDate, range.endDate]);
  });
});
