import { describe, expect, it } from "vitest";
import {
  describeDirectoryProgress,
  directoryProgressRatio,
} from "./directory-progress";

describe("directory progress", () => {
  it("describes each load state", () => {
    expect(
      describeDirectoryProgress({
        status: "loading",
        completedGroups: 1_200,
        totalGroups: 5_000,
      }),
    ).toBe("1,200 of 5,000 groups loaded");
    expect(
      describeDirectoryProgress({
        status: "loading",
        completedGroups: 3,
        totalGroups: null,
      }),
    ).toBe("3 groups loaded");
    expect(
      describeDirectoryProgress({
        status: "failed",
        completedGroups: 0,
        totalGroups: null,
      }),
    ).toBe("Unavailable; activity loads without groups");
  });

  it("reports a ratio only when the total is known", () => {
    expect(
      directoryProgressRatio({
        status: "loading",
        completedGroups: 1,
        totalGroups: 4,
      }),
    ).toBe(0.25);
    expect(
      directoryProgressRatio({
        status: "loading",
        completedGroups: 1,
        totalGroups: null,
      }),
    ).toBeNull();
    expect(
      directoryProgressRatio({
        status: "ready",
        completedGroups: 0,
        totalGroups: null,
      }),
    ).toBe(1);
  });
});
