// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workbook = vi.hoisted(() => ({
  toBlob: vi.fn(),
  write: vi.fn(),
}));

vi.mock("write-excel-file/browser", () => ({
  default: workbook.write,
}));

import { exportRecordsTable, type ExportManifest } from "./dashboard-export";
import type { McpRecord } from "../../contracts/mcp-response";

beforeEach(() => {
  workbook.toBlob.mockResolvedValue(new Blob(["xlsx"]));
  workbook.write.mockReturnValue({ toBlob: workbook.toBlob });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  workbook.toBlob.mockReset();
  workbook.write.mockReset();
});

describe("XLSX exports", () => {
  it("writes manifest and activity sheets with safe cell values", async () => {
    const createObjectUrl = vi.fn(() => "blob:export");
    const revokeObjectUrl = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
    let downloadedFilename = "";
    vi.spyOn(
      globalThis.HTMLAnchorElement.prototype,
      "click",
    ).mockImplementation(function captureDownload(this: HTMLAnchorElement) {
      downloadedFilename = this.download;
    });
    const record: McpRecord = {
      date: "2026-09-18",
      userId: "user_1",
      email: "user@example.test",
      displayName: "=unsafe",
      server: "github",
      tool: "search",
      usage: 3,
      origin: "external",
    };
    const manifest: ExportManifest = {
      team: "Example Team",
      generatedAt: "2026-09-18T12:00:00.000Z",
      exportedAt: "2026-09-21T12:00:00.000Z",
      range: { startDate: "2026-09-01", endDate: "2026-09-18" },
      filters: {},
      lockedFields: [],
      sourceRecordCount: 1,
      exportedRowCount: 1,
      exportedGrain: "activity",
      identityPolicy: "named",
    };

    await exportRecordsTable([record], "xlsx", "mcp-activity", manifest);

    expect(workbook.write).toHaveBeenCalledOnce();
    const sheets = workbook.write.mock.calls[0][0] as Array<{
      sheet: string;
      data: Array<Array<unknown>>;
    }>;
    expect(sheets.map((sheet) => sheet.sheet)).toEqual([
      "Manifest",
      "Activity",
    ]);
    expect(sheets[1].data[1][7]).toBe("'=unsafe");
    expect(workbook.toBlob).toHaveBeenCalledOnce();
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(downloadedFilename).toBe("mcp-activity.xlsx");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:export");
  });
});
