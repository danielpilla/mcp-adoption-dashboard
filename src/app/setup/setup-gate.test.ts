// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StartupRange } from "../../contracts/startup-range";
import {
  inclusiveDayCount,
  presetRange,
  shiftIsoDate,
} from "../dashboard/dashboard-dates";
import { STARTUP_RANGE_STORAGE_KEY } from "./range-choice";
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Coverage with every cacheable day of the last `days` days cached. */
function warmCoverage(days: number) {
  const { startDate, endDate } = presetRange(days);
  const cacheableThrough = shiftIsoDate(endDate, -3);
  return {
    firstDate: startDate,
    lastDate: cacheableThrough,
    days: inclusiveDayCount({ startDate, endDate: cacheableThrough }),
    cacheableThrough,
    spans: [{ startDate, endDate: cacheableThrough }],
  };
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

function pendingResponse() {
  return new Response(new ReadableStream<Uint8Array>(), { status: 200 });
}

type Routes = {
  status: Record<string, unknown>;
  stream?: () => Response;
  saveRange?: (range: unknown) => Response;
};

function routeFetch({ status, stream = pendingResponse, saveRange }: Routes) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/setup/status") {
      return jsonResponse({ configured: true, setupAllowed: true, ...status });
    }
    if (url === "/api/setup/range") {
      const range: unknown = JSON.parse(String(init?.body));
      return saveRange
        ? saveRange(range)
        : jsonResponse({ rangePreference: range });
    }
    if (url.startsWith("/api/mcp/stream?")) {
      if (init?.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      return stream();
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function requestedUrls(fetcher: ReturnType<typeof routeFetch>) {
  return fetcher.mock.calls.map(([input]) => String(input));
}

function streamRange(fetcher: ReturnType<typeof routeFetch>) {
  const call = requestedUrls(fetcher).find((url) =>
    url.startsWith("/api/mcp/stream?"),
  );
  const url = new URL(String(call), "http://localhost");
  return {
    startDate: url.searchParams.get("startDate") ?? "",
    endDate: url.searchParams.get("endDate") ?? "",
  };
}

function heading(container: HTMLElement) {
  return container.querySelector("h1")?.textContent;
}

async function waitForHeading(container: HTMLElement, text: string) {
  await act(async () => {
    await vi.waitFor(() => expect(heading(container)).toBe(text));
  });
}

function submitButton(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>(".range-submit");
  if (!button) throw new Error("The range step is not shown.");
  return button;
}

function checkedPreset(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>(
    ".range-presets input:checked",
  )?.value;
}

async function confirmRange(container: HTMLElement) {
  await waitForHeading(container, "Pick a starting range");
  await act(async () => submitButton(container).click());
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  globalThis.document.body.replaceChildren();
  globalThis.localStorage.clear();
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
    const fetcher = routeFetch({
      status: {
        rangePreference: { kind: "preset", days: 30 },
        cacheCoverage: warmCoverage(30),
      },
      stream: () => chunkedResponse([event.slice(0, 17), event.slice(17)]),
    });
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );

    await waitForHeading(container, "Connect Cursor");

    expect(container.textContent).toContain("The saved key expired.");
    expect(requestedUrls(fetcher)).toEqual([
      "/api/setup/status",
      expect.stringMatching(/^\/api\/mcp\/stream\?/),
    ]);
  });

  it("rejects malformed progress events", async () => {
    routeFetch({
      status: {},
      stream: () =>
        chunkedResponse([
          `${JSON.stringify({
            type: "progress",
            completed: "1",
            total: 2,
            label: "MCP activity",
            detail: "1 / 2 date ranges",
          })}\n`,
        ]),
    });
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );

    await confirmRange(container);
    await waitForHeading(container, "Dashboard couldn’t load");

    expect(container.textContent).toContain(
      "The local server returned invalid progress.",
    );
    expect(container.textContent).toContain("Change range");
  });

  it("shows directory and day progress while the dashboard loads", async () => {
    const encoder = new TextEncoder();
    const progress = {
      type: "progress",
      completed: 1,
      total: 3,
      label: "MCP activity",
      detail: "1 / 2 date ranges",
      directory: { status: "loading", completedGroups: 2, totalGroups: 5 },
      activity: {
        state: "loading",
        totalDays: 30,
        cachedDays: 20,
        fetchedDays: 4,
        records: 1250,
        completedWindows: 1,
        totalWindows: 2,
        windows: [
          {
            startDate: "2026-01-01",
            endDate: "2026-01-06",
            days: 6,
            pagesLoaded: 1,
            totalPages: 2,
          },
        ],
        retry: null,
        elapsedMs: 1000,
        idleMs: 100,
      },
    };
    routeFetch({
      status: {
        rangePreference: { kind: "preset", days: 30 },
        cacheCoverage: warmCoverage(30),
      },
      stream: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(`${JSON.stringify(progress)}\n`),
              );
            },
          }),
          { status: 200 },
        ),
    });
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
    expect(container.textContent).toContain("20 from cache");
    expect(container.textContent).toContain("4 fetched");
    expect(container.textContent).toContain("1,250");
    expect(container.textContent).toContain("Fetching Jan 1 – Jan 6");
  });

  it.each([
    [{ defaultRangeDays: 14 }, 14],
    [{ defaultRangeDays: 366 }, 366],
    [{}, 90],
    [{ defaultRangeDays: 0 }, 90],
    [{ defaultRangeDays: 367 }, 90],
    [{ defaultRangeDays: "14" }, 90],
  ])(
    "pre-selects the default range from setup status %j",
    async (status, expectedDays) => {
      const fetcher = routeFetch({ status });
      const container = await render(
        createElement(SetupGate, { initialData: null }),
      );

      await waitForHeading(container, "Pick a starting range");
      expect(submitButton(container).textContent).toBe(
        `Load ${expectedDays} days`,
      );
      expect(requestedUrls(fetcher)).toEqual(["/api/setup/status"]);

      await act(async () => submitButton(container).click());
      await waitForHeading(container, "Loading dashboard");

      expect(container.querySelector(".eyebrow")?.textContent).toBe(
        `${expectedDays}-day view`,
      );
      const range = streamRange(fetcher);
      expect(range).toEqual(presetRange(expectedDays));
      expect(inclusiveDayCount(range)).toBe(expectedDays);
    },
  );
});

describe("setup gate startup range", () => {
  it("loads a remembered range at once when its days are cached", async () => {
    const fetcher = routeFetch({
      status: {
        rangePreference: { kind: "preset", days: 180 },
        cacheCoverage: warmCoverage(180),
      },
    });
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );

    await waitForHeading(container, "Loading dashboard");

    expect(container.querySelector(".range-step")).toBeNull();
    expect(streamRange(fetcher)).toEqual(presetRange(180));
    expect(container.textContent).toContain("Change range");
  });

  it("asks again when the remembered range is not cached", async () => {
    routeFetch({
      status: {
        rangePreference: { kind: "preset", days: 365 },
        cacheCoverage: null,
      },
    });
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );

    await waitForHeading(container, "Pick a starting range");

    expect(checkedPreset(container)).toBe("365");
    const selected = container.querySelector(".range-card.is-selected");
    expect(selected?.textContent).toContain("Last used");
  });

  it("pre-selects the largest fully cached preset when nothing is remembered", async () => {
    routeFetch({
      status: { rangePreference: null, cacheCoverage: warmCoverage(180) },
    });
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );

    await waitForHeading(container, "Pick a starting range");

    expect(checkedPreset(container)).toBe("180");
    const cards = [...container.querySelectorAll(".range-card")];
    expect(cards.map((card) => card.classList.contains("is-cached"))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(cards[4]?.textContent).toMatch(/\d+% cached/);
    expect(container.textContent).toContain("Cached days load instantly");
  });

  it("remembers the chosen range on the server and in the browser", async () => {
    const fetcher = routeFetch({ status: {} });
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );
    await waitForHeading(container, "Pick a starting range");

    const sevenDays = container.querySelector<HTMLInputElement>(
      '.range-presets input[value="7"]',
    );
    await act(async () => sevenDays?.click());
    expect(submitButton(container).textContent).toBe("Load 7 days");
    await act(async () => submitButton(container).click());
    await waitForHeading(container, "Loading dashboard");

    const saved = fetcher.mock.calls.find(
      ([input]) => String(input) === "/api/setup/range",
    );
    expect(saved?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(saved?.[1]?.body))).toEqual({
      kind: "preset",
      days: 7,
    });
    expect(
      JSON.parse(
        globalThis.localStorage.getItem(STARTUP_RANGE_STORAGE_KEY) ?? "null",
      ),
    ).toEqual({ kind: "preset", days: 7 });
    expect(streamRange(fetcher)).toEqual(presetRange(7));
  });

  it("falls back to the browser copy when the server has none", async () => {
    const remembered: StartupRange = { kind: "preset", days: 30 };
    globalThis.localStorage.setItem(
      STARTUP_RANGE_STORAGE_KEY,
      JSON.stringify(remembered),
    );
    const fetcher = routeFetch({
      status: { rangePreference: null, cacheCoverage: warmCoverage(30) },
    });
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );

    await waitForHeading(container, "Loading dashboard");
    expect(streamRange(fetcher)).toEqual(presetRange(30));
  });

  it("returns to the range step from the loading screen", async () => {
    const fetcher = routeFetch({
      status: {
        rangePreference: { kind: "preset", days: 90 },
        cacheCoverage: warmCoverage(90),
      },
    });
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );
    await waitForHeading(container, "Loading dashboard");
    const streamInit = fetcher.mock.calls.find(([input]) =>
      String(input).startsWith("/api/mcp/stream?"),
    )?.[1];

    const change = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Change range",
    );
    await act(async () => change?.click());

    await waitForHeading(container, "Pick a starting range");
    expect(streamInit?.signal?.aborted).toBe(true);
    expect(checkedPreset(container)).toBe("90");
    expect(
      container.querySelector(".range-card.is-selected")?.textContent,
    ).toContain("Last used");
  });

  it("validates a custom range before loading", async () => {
    const fetcher = routeFetch({ status: {} });
    const container = await render(
      createElement(SetupGate, { initialData: null }),
    );
    await waitForHeading(container, "Pick a starting range");
    const [start, end] = container.querySelectorAll<HTMLInputElement>(
      ".range-custom input",
    );
    if (!start || !end) throw new Error("Missing custom range inputs.");
    const today = presetRange(1).endDate;

    await act(async () => setInputValue(start, shiftIsoDate(today, -400)));

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Ranges are limited to 366 days; this one is 401.",
    );
    expect(submitButton(container).disabled).toBe(true);
    expect(checkedPreset(container)).toBeUndefined();

    await act(async () => setInputValue(start, shiftIsoDate(today, -9)));

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(submitButton(container).textContent).toBe("Load 10 days");
    await act(async () => submitButton(container).click());
    await waitForHeading(container, "Loading dashboard");
    expect(streamRange(fetcher)).toEqual({
      startDate: shiftIsoDate(today, -9),
      endDate: today,
    });
  });
});
