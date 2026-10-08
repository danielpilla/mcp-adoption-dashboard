// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inclusiveDayCount, presetRange } from "../dashboard/dashboard-dates";
import { SetupGate } from "./setup-gate";

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

function setupStatusResponse(extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({ configured: true, setupAllowed: true, ...extra }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function chunkedResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  globalThis.document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("setup gate stream handling", () => {
  it("handles a setup-required event split across stream chunks", async () => {
    const event = `${JSON.stringify({
      type: "error",
      code: "SETUP_REQUIRED",
      error: "The saved key expired.",
    })}\n`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(setupStatusResponse())
      .mockResolvedValueOnce(
        chunkedResponse([event.slice(0, 17), event.slice(17)]),
      );
    vi.stubGlobal("fetch", fetcher);
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );

    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector("h1")?.textContent).toBe(
          "Connect Cursor",
        ),
      );
    });

    expect(container.textContent).toContain("The saved key expired.");
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/setup/status",
      expect.stringMatching(/^\/api\/mcp\/stream\?/),
    ]);
  });

  it("rejects malformed progress events", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(setupStatusResponse())
      .mockResolvedValueOnce(
        chunkedResponse([
          `${JSON.stringify({
            type: "progress",
            completed: "1",
            total: 2,
            label: "MCP activity",
            detail: "1 / 2 date ranges",
          })}\n`,
        ]),
      );
    vi.stubGlobal("fetch", fetcher);
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );

    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector("h1")?.textContent).toBe(
          "Dashboard couldn’t load",
        ),
      );
    });

    expect(container.textContent).toContain(
      "The local server returned invalid progress.",
    );
  });

  it("shows directory progress while the dashboard loads", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "progress",
              completed: 1,
              total: 3,
              label: "MCP activity",
              detail: "1 / 2 date ranges",
              directory: {
                status: "loading",
                completedGroups: 2,
                totalGroups: 5,
              },
            })}\n`,
          ),
        );
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(setupStatusResponse())
      .mockResolvedValueOnce(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );

    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("2 of 5 groups loaded"),
      );
    });

    expect(container.textContent).toContain("Directory groups");
    expect(container.textContent).toContain("40%");
  });

  it.each([
    [{ defaultRangeDays: 14 }, 14],
    [{ defaultRangeDays: 366 }, 366],
    [{}, 90],
    [{ defaultRangeDays: 0 }, 90],
    [{ defaultRangeDays: 367 }, 90],
    [{ defaultRangeDays: "14" }, 90],
  ])(
    "loads the initial range from setup status %j",
    async (status, expectedDays) => {
      const pendingStream = new ReadableStream<Uint8Array>();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(setupStatusResponse(status))
        .mockResolvedValueOnce(new Response(pendingStream, { status: 200 }));
      vi.stubGlobal("fetch", fetcher);
      const container = await render(
        createElement(SetupGate, { initialData: null }),
      );

      await act(async () => {
        await vi.waitFor(() =>
          expect(container.querySelector("h1")?.textContent).toBe(
            "Loading dashboard",
          ),
        );
      });

      expect(container.querySelector(".eyebrow")?.textContent).toBe(
        `${expectedDays}-day view`,
      );
      const streamUrl = new URL(
        String(fetcher.mock.calls[1]?.[0]),
        "http://localhost",
      );
      const range = {
        startDate: streamUrl.searchParams.get("startDate") ?? "",
        endDate: streamUrl.searchParams.get("endDate") ?? "",
      };
      expect(range).toEqual(presetRange(expectedDays));
      expect(inclusiveDayCount(range)).toBe(expectedDays);
    },
  );
});
