// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDirectoryStatus } from "./use-directory-status";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  globalThis.document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Probe({
  enabled,
  onReady,
}: {
  enabled: boolean;
  onReady: () => void;
}) {
  const progress = useDirectoryStatus(enabled, onReady);
  return createElement("output", null, progress?.status ?? "none");
}

function statusResponse(status: string, completedGroups: number) {
  return new Response(
    JSON.stringify({ status, completedGroups, totalGroups: 2 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("directory status polling", () => {
  it("polls until the directory is ready and then reports it once", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(statusResponse("loading", 1))
      .mockResolvedValueOnce(statusResponse("ready", 2));
    vi.stubGlobal("fetch", fetcher);
    const onReady = vi.fn();
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () =>
      root.render(createElement(Probe, { enabled: true, onReady })),
    );
    expect(container.textContent).toBe("loading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(container.textContent).toBe("ready");
    expect(onReady).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not poll while disabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () =>
      root.render(createElement(Probe, { enabled: false, onReady: vi.fn() })),
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(container.textContent).toBe("none");
  });
});
