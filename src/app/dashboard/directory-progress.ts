import type { DirectoryLoadProgress } from "./dashboard-stream";

const countFormat = new Intl.NumberFormat("en-US");

/** Short, human-readable state of the background directory load. */
export function describeDirectoryProgress(
  progress: DirectoryLoadProgress,
): string {
  switch (progress.status) {
    case "loading": {
      const completed = countFormat.format(progress.completedGroups);
      return progress.totalGroups === null
        ? `${completed} groups loaded`
        : `${completed} of ${countFormat.format(progress.totalGroups)} groups loaded`;
    }
    case "ready":
      return "Loaded";
    case "failed":
      return "Unavailable; activity loads without groups";
    case "idle":
      return "Waiting to start";
    case "disabled":
      return "Not loaded";
  }
}

/** Fraction of directory groups loaded, or null when the total is unknown. */
export function directoryProgressRatio(
  progress: DirectoryLoadProgress,
): number | null {
  if (progress.status === "ready") return 1;
  if (progress.totalGroups === null || progress.totalGroups === 0) return null;
  return Math.min(1, progress.completedGroups / progress.totalGroups);
}
