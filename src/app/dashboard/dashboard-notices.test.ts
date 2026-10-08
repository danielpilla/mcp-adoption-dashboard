// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardNotices } from "./dashboard-notices";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

async function render(props: Parameters<typeof DashboardNotices>[0]) {
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(createElement(DashboardNotices, props)));
  return container;
}

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  globalThis.document.body.replaceChildren();
});

const activeRange = { startDate: "2026-07-01", endDate: "2026-09-28" };

describe("dashboard notices", () => {
  it("renders nothing without notices", async () => {
    const container = await render({
      notices: [],
      directory: null,
      activeRange,
    });

    expect(container.innerHTML).toBe("");
  });

  it("explains partial data and offers the complete days", async () => {
    const onShowFrom = vi.fn();
    const container = await render({
      notices: [
        {
          code: "LIMIT_REACHED",
          message: "Showing partial activity.",
          setting: "MAX_MCP_RECORDS",
          completeFrom: "2026-08-15",
        },
      ],
      directory: null,
      activeRange,
      onShowFrom,
    });

    expect(container.querySelector("h2")?.textContent).toBe(
      "Showing partial data",
    );
    expect(container.textContent).toContain("Showing partial activity.");
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Show complete days from 2026-08-15");
    await act(async () => button?.click());
    expect(onShowFrom).toHaveBeenCalledWith("2026-08-15");
  });

  it("hides the complete-days action when the view already starts there", async () => {
    const container = await render({
      notices: [
        {
          code: "LIMIT_REACHED",
          message: "Showing partial activity.",
          completeFrom: "2026-07-01",
        },
      ],
      directory: null,
      activeRange,
      onShowFrom: vi.fn(),
    });

    expect(container.querySelector("button")).toBeNull();
  });

  it("shows live directory progress for a loading directory", async () => {
    const container = await render({
      notices: [{ code: "DIRECTORY_LOADING", message: "Loading." }],
      directory: { status: "loading", completedGroups: 4, totalGroups: 8 },
      activeRange,
    });

    expect(container.querySelector("h2")?.textContent).toBe(
      "Directory groups still loading",
    );
    expect(container.textContent).toContain("4 of 8 groups loaded");
  });
});
