import { useEffect, useState } from "react";
import {
  parseDirectoryProgress,
  type DirectoryLoadProgress,
} from "./dashboard-stream";

const POLL_INTERVAL_MS = 3_000;

/**
 * Polls the background directory load while `enabled` is true and calls
 * `onReady` once when it finishes.
 */
export function useDirectoryStatus(
  enabled: boolean,
  onReady: () => void,
): DirectoryLoadProgress | null {
  const [progress, setProgress] = useState<DirectoryLoadProgress | null>(null);

  useEffect(() => {
    if (!enabled) {
      setProgress(null);
      return;
    }
    let active = true;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch("/api/directory/status", {
          cache: "no-store",
          signal: controller.signal,
        });
        const next = response.ok
          ? parseDirectoryProgress(await response.json())
          : undefined;
        if (!active) return;
        if (next) setProgress(next);
        if (next?.status === "ready") {
          onReady();
          return;
        }
        if (next?.status === "failed" || next?.status === "disabled") return;
      } catch {
        if (!active) return;
      }
      timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, onReady]);

  return progress;
}
