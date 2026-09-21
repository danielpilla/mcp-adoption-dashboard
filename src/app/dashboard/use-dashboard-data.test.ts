// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useDashboardData,
  type DashboardDataController,
} from "./use-dashboard-data";
import { configureInternalMcpServers } from "../../contracts/mcp-origin";
import type { DateRange, McpResponse } from "../../contracts/mcp-response";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const initialRange: DateRange = {
  startDate: "2026-09-01",
  endDate: "2026-09-18",
};
const initialData: McpResponse = {
  records: [],
  summary: {
    totalUsage: 0,
    uniqueUsers: 0,
    uniqueServers: 0,
    uniqueTools: 0,
  },
  range: initialRange,
  generatedAt: "2026-09-18T12:00:00.000Z",
  source: "live",
};

async function render(element: ReactNode) {
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  configureInternalMcpServers(undefined);
  globalThis.document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dashboard data controller", () => {
  it("keeps current data and requests setup after a 428 response", async () => {
    const onSetupRequired = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Dashboard setup is required.",
          code: "SETUP_REQUIRED",
        }),
        {
          status: 428,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    let controller: DashboardDataController | undefined;
    function Harness() {
      controller = useDashboardData({
        initialData,
        initialRange,
        onSetupRequired,
        onBeforeRangeChange: () => undefined,
      });
      return createElement("output", null, controller.state.error);
    }
    await render(createElement(Harness));

    await act(async () => {
      await controller?.actions.loadData({
        startDate: "2026-08-01",
        endDate: "2026-09-18",
      });
    });

    expect(onSetupRequired).toHaveBeenCalledOnce();
    expect(controller?.state.data).toBe(initialData);
    expect(controller?.state.error).toBe("");
    expect(controller?.state.loading).toBe(false);
  });

  it("applies an in-range drill without another request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    let controller: DashboardDataController | undefined;
    function Harness() {
      controller = useDashboardData({
        initialData,
        initialRange,
        onBeforeRangeChange: () => undefined,
      });
      return createElement(
        "output",
        null,
        controller.state.activeRange.startDate,
      );
    }
    await render(createElement(Harness));
    const drillRange = {
      startDate: "2026-09-05",
      endDate: "2026-09-10",
    };

    await act(async () => {
      await controller?.actions.applyRange(drillRange);
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(controller?.state.activeRange).toEqual(drillRange);
    expect(controller?.state.data).toBe(initialData);
  });

  it("loads and validates a range outside the current data", async () => {
    const nextRange = {
      startDate: "2026-08-01",
      endDate: "2026-09-18",
    };
    const responseData: McpResponse = {
      ...initialData,
      range: nextRange,
      generatedAt: "2026-09-18T13:00:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(responseData), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    let controller: DashboardDataController | undefined;
    function Harness() {
      controller = useDashboardData({
        initialData,
        initialRange,
        onBeforeRangeChange: () => undefined,
      });
      return createElement("output", null, controller.state.data?.generatedAt);
    }
    await render(createElement(Harness));

    await act(async () => {
      await controller?.actions.loadData(nextRange);
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/mcp?startDate=2026-08-01&endDate=2026-09-18",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(controller?.state.data).toEqual(responseData);
    expect(controller?.state.activeRange).toEqual(nextRange);
    expect(controller?.state.loading).toBe(false);
  });
});
