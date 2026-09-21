import { describe, expect, it } from "vitest";
import {
  buildScopedSnapshotPayload,
  buildSnapshotHtml,
} from "./dashboard-export";
import type { McpResponse } from "../../contracts/mcp-response";

const payload: McpResponse = {
  records: [
    {
      date: "2026-09-18",
      userId: "user_1",
      email: "alex@example.com",
      displayName: "<Alex>",
      server: "github",
      tool: "search",
      usage: 5,
    },
  ],
  summary: {
    totalUsage: 5,
    uniqueUsers: 1,
    uniqueServers: 1,
    uniqueTools: 1,
  },
  range: { startDate: "2026-09-01", endDate: "2026-09-18" },
  generatedAt: "2026-09-18T16:00:00.000Z",
  source: "live",
};

describe("HTML snapshot generation", () => {
  it("embeds safe offline data without executable markup", () => {
    const html = buildSnapshotHtml(
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
      payload,
    );

    expect(html).toContain('id="mcp-snapshot"');
    expect(html).toContain('id="mcp-snapshot-manifest"');
    expect(html).toContain('"source":"snapshot"');
    expect(html).toContain('"recordCount":1');
    expect(html).toContain("\\u003cAlex>");
    expect(html).not.toContain("<Alex>");
  });

  it("rejects payloads that resemble API credentials", () => {
    const unsafe = {
      ...payload,
      records: [
        {
          ...payload.records[0],
          displayName: ["key", "this_looks_like_a_real_secret"].join("_"),
        },
      ],
    };

    expect(() =>
      buildSnapshotHtml("<html><head></head></html>", unsafe),
    ).toThrow("Snapshot safety check failed");
  });

  it("rejects current Cursor API key formats", () => {
    const unsafe = {
      ...payload,
      records: [
        {
          ...payload.records[0],
          displayName: ["crsr", "1234567890abcdefghijklmnop"].join("_"),
        },
      ],
    };

    expect(() =>
      buildSnapshotHtml("<html><head></head></html>", unsafe),
    ).toThrow("Snapshot safety check failed");
  });

  it("uses the filtered range and recomputes exported totals", () => {
    const scoped = buildScopedSnapshotPayload(payload, [], {
      startDate: "2026-09-10",
      endDate: "2026-09-10",
    });

    expect(scoped.range).toEqual({
      startDate: "2026-09-10",
      endDate: "2026-09-10",
    });
    expect(scoped.summary).toEqual({
      totalUsage: 0,
      uniqueUsers: 0,
      uniqueServers: 0,
      uniqueTools: 0,
    });
    expect(scoped.snapshotScope).toMatchObject({
      version: 1,
      source: {
        kind: "live",
        generatedAt: "2026-09-18T16:00:00.000Z",
        range: {
          startDate: "2026-09-01",
          endDate: "2026-09-18",
        },
        recordCount: 1,
      },
      scope: {
        range: {
          startDate: "2026-09-10",
          endDate: "2026-09-10",
        },
        recordCount: 0,
        narrowedFromSource: true,
      },
    });
  });
});
