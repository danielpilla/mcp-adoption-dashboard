// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function setupStatusResponse() {
  return new Response(
    JSON.stringify({ configured: true, setupAllowed: true }),
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
});
