import { describe, expect, it } from "vitest";
import type { Filters } from "./filter-model";
import type { AssociationOption } from "./associative-model";
import {
  clearUnlockedSelections,
  countSelections,
  countUnlockedSelections,
  mergeSelectionChanges,
  toggleSelectionChange,
  valuesForAssociationAction,
} from "./selection-model";

function filters(overrides: Partial<Filters> = {}): Filters {
  return {
    query: "",
    origins: [],
    users: [],
    servers: [],
    tools: [],
    groups: [],
    dates: [],
    days: [],
    weeks: [],
    months: [],
    monthYears: [],
    quarters: [],
    years: [],
    ...overrides,
  };
}

describe("visual selection sessions", () => {
  it("clears unlocked fields while preserving locked selections", () => {
    expect(
      clearUnlockedSelections(
        filters({
          query: "github",
          origins: ["external"],
          users: ["alice@example.com"],
          servers: ["github"],
        }),
        new Set(["origins", "servers"]),
      ),
    ).toMatchObject({
      query: "",
      origins: ["external"],
      users: [],
      servers: ["github"],
    });
  });

  it("counts only selections that the global clear action can remove", () => {
    expect(
      countUnlockedSelections(
        filters({
          query: "github",
          origins: ["external"],
          users: ["alice@example.com"],
          servers: ["github", "slack"],
        }),
        new Set(["origins", "servers"]),
      ),
    ).toBe(2);
    expect(
      countSelections(
        filters({
          query: "github",
          origins: ["external"],
          users: ["alice@example.com"],
          servers: ["github", "slack"],
        }),
      ),
    ).toBe(5);
  });

  it("builds additive changes and removes them when toggled back", () => {
    const baseline = filters({ servers: ["github"] });
    const added = toggleSelectionChange(baseline, {}, "servers", "slack");
    expect(added.servers).toEqual(["github", "slack"]);

    const reverted = toggleSelectionChange(baseline, added, "servers", "slack");
    expect(reverted).toEqual({});
  });

  it("can draft removal of a committed value", () => {
    expect(
      toggleSelectionChange(
        filters({ users: ["alice@example.com"] }),
        {},
        "users",
        "alice@example.com",
      ),
    ).toEqual({ users: [] });
  });

  it("merges partial selection changes without altering other fields", () => {
    expect(
      mergeSelectionChanges(filters({ query: "github", users: ["alice"] }), {
        users: ["bob"],
        servers: ["github"],
      }),
    ).toEqual(
      filters({
        query: "github",
        users: ["bob"],
        servers: ["github"],
      }),
    );
  });
});

describe("Qlik-style association actions", () => {
  const options: AssociationOption[] = [
    {
      value: "selected",
      label: "Selected",
      state: "selected",
      count: 1,
      usage: 1,
    },
    {
      value: "possible",
      label: "Possible",
      state: "possible",
      count: 1,
      usage: 1,
    },
    {
      value: "alternative",
      label: "Alternative",
      state: "alternative",
      count: 1,
      usage: 1,
    },
    {
      value: "excluded",
      label: "Excluded",
      state: "excluded",
      count: 0,
      usage: 0,
    },
    {
      value: "selectedExcluded",
      label: "Selected excluded",
      state: "selectedExcluded",
      count: 0,
      usage: 0,
    },
  ];

  it("selects all and possible states exactly", () => {
    expect(valuesForAssociationAction(options, "all")).toEqual(
      options.map((option) => option.value),
    );
    expect(valuesForAssociationAction(options, "possible")).toEqual([
      "possible",
    ]);
  });

  it("selects alternative values as a replacement set", () => {
    expect(valuesForAssociationAction(options, "alternative")).toEqual([
      "alternative",
    ]);
  });

  it("selects excluded values exactly", () => {
    expect(valuesForAssociationAction(options, "excluded")).toEqual([
      "excluded",
    ]);
  });

  it("selects excluded values when no alternatives exist", () => {
    const withoutAlternatives = options.filter(
      (option) => option.state !== "alternative",
    );
    expect(valuesForAssociationAction(withoutAlternatives, "excluded")).toEqual(
      ["excluded"],
    );
  });
});
