import { describe, expect, it } from "vitest";
import type { McpRecord } from "../../contracts/mcp-response";
import { configureInternalMcpServers } from "../../contracts/mcp-origin";
import { buildAssociativeModel } from "./associative-model";
import { NO_GROUP_VALUE, type Filters } from "./filter-model";

const records: McpRecord[] = [
  {
    date: "2026-09-01",
    userId: "1",
    email: "alex@example.test",
    displayName: "Alex",
    server: "github",
    tool: "search",
    usage: 10,
    directoryGroups: ["Customer Success"],
  },
  {
    date: "2026-09-02",
    userId: "1",
    email: "alex@example.test",
    displayName: "Alex",
    server: "slack",
    tool: "send",
    usage: 5,
    directoryGroups: ["Customer Success", "Early Adopters"],
  },
  {
    date: "2026-09-01",
    userId: "2",
    email: "bailey@example.test",
    displayName: "Bailey",
    server: "github",
    tool: "issues",
    usage: 7,
    directoryGroups: ["Engineering"],
  },
  {
    date: "2026-09-01",
    userId: "3",
    email: "casey@example.test",
    displayName: "Casey",
    server: "notion",
    tool: "fetch",
    usage: 3,
    directoryGroups: ["Product"],
  },
];

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

function state(
  model: ReturnType<typeof buildAssociativeModel>,
  field: keyof typeof model.options,
  value: string,
) {
  return model.options[field].find((option) => option.value === value)?.state;
}

describe("Qlik-style associative inference", () => {
  it("keeps an actual No group membership distinct from ungrouped records", () => {
    const model = buildAssociativeModel(
      [
        {
          ...records[0],
          email: "named@example.test",
          directoryGroups: ["No group"],
        },
        {
          ...records[0],
          email: "ungrouped@example.test",
          directoryGroups: [],
        },
      ],
      filters({ groups: [NO_GROUP_VALUE] }),
    );

    expect(model.records.map((record) => record.email)).toEqual([
      "ungrouped@example.test",
    ]);
    expect(
      model.options.groups.find((option) => option.value === NO_GROUP_VALUE)
        ?.label,
    ).toBe("No group");
  });

  it("uses OR within a field and AND across fields", () => {
    const model = buildAssociativeModel(
      records,
      filters({
        users: ["alex@example.test"],
        servers: ["github", "slack"],
      }),
    );
    expect(model.records).toHaveLength(2);
  });

  it("marks selected, possible, alternative, and excluded values", () => {
    const model = buildAssociativeModel(
      records,
      filters({ users: ["alex@example.test"] }),
    );

    expect(state(model, "users", "alex@example.test")).toBe("selected");
    expect(state(model, "users", "bailey@example.test")).toBe("alternative");
    expect(state(model, "servers", "github")).toBe("possible");
    expect(state(model, "servers", "slack")).toBe("possible");
    expect(state(model, "servers", "notion")).toBe("excluded");
    expect(state(model, "groups", "Customer Success")).toBe("possible");
    expect(state(model, "groups", "Product")).toBe("excluded");
  });

  it("retains incompatible selections as selected-excluded", () => {
    const model = buildAssociativeModel(
      records,
      filters({
        users: ["alex@example.test"],
        servers: ["notion"],
      }),
    );

    expect(model.records).toHaveLength(0);
    expect(state(model, "users", "alex@example.test")).toBe("selectedExcluded");
    expect(state(model, "servers", "notion")).toBe("selectedExcluded");
    expect(model.contextRecords.servers).toHaveLength(2);
    expect(model.networkRecords).toEqual(records);
  });

  it("filters by MCP origin and badges internal server options", () => {
    configureInternalMcpServers("example-internal-mcp");
    const internalRecord = {
      ...records[0],
      server: "example-internal-mcp",
    };
    const model = buildAssociativeModel(
      [...records, internalRecord],
      filters({ origins: ["internal"] }),
    );

    expect(model.records).toEqual([internalRecord]);
    expect(state(model, "origins", "internal")).toBe("selected");
    expect(state(model, "origins", "external")).toBe("alternative");
    expect(
      model.options.servers.find(
        (option) => option.value === "example-internal-mcp",
      )?.badge,
    ).toBe("Internal");
  });
});
