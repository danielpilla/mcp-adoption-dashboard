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

  it("streams a range outside the current data with progress", async () => {
    const nextRange = {
      startDate: "2026-08-01",
      endDate: "2026-09-18",
    };
    const responseData: McpResponse = {
      ...initialData,
      range: nextRange,
      generatedAt: "2026-09-18T13:00:00.000Z",
    };
    const encoder = new TextEncoder();
    let push: ((line: unknown) => void) | undefined;
    let close: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (line) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        close = () => controller.close();
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
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

    let loading: Promise<void> | undefined;
    await act(async () => {
      loading = controller?.actions.loadData(nextRange);
    });
    await act(async () => {
      push?.({
        type: "progress",
        completed: 1,
        total: 2,
        label: "MCP activity",
        detail: "1 / 2 date ranges",
        activity: {
          state: "loading",
          totalDays: 49,
          cachedDays: 19,
          fetchedDays: 30,
          records: 42,
          completedWindows: 1,
          totalWindows: 1,
          windows: [],
          retry: null,
          elapsedMs: 900,
          idleMs: 10,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controller?.state.loadProgress?.activity?.records).toBe(42);
    expect(controller?.state.loading).toBe(true);
    expect(controller?.state.data).toBe(initialData);
    expect(controller?.state.loadProgress?.receivedAt).toEqual(
      expect.any(Number),
    );

    await act(async () => {
      push?.({ type: "data", data: responseData });
      close?.();
      await loading;
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/mcp/stream?startDate=2026-08-01&endDate=2026-09-18",
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(controller?.state.data).toEqual(responseData);
    expect(controller?.state.activeRange).toEqual(nextRange);
    expect(controller?.state.loading).toBe(false);
    expect(controller?.state.loadProgress).toBeNull();
  });

  it("requests setup when the stream reports an expired key", async () => {
    const onSetupRequired = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `${JSON.stringify({
          type: "error",
          code: "SETUP_REQUIRED",
          error: "Dashboard setup is required.",
        })}\n`,
        { status: 200 },
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
    expect(controller?.state.loadProgress).toBeNull();
  });

  it("keeps the current range when the stream fails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          `${JSON.stringify({ type: "error", error: "Upstream failed." })}\n`,
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    let controller: DashboardDataController | undefined;
    function Harness() {
      controller = useDashboardData({
        initialData,
        initialRange,
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

    expect(controller?.state.error).toBe("Upstream failed.");
    expect(controller?.state.activeRange).toEqual(initialRange);
    expect(controller?.state.data).toBe(initialData);
  });
});
