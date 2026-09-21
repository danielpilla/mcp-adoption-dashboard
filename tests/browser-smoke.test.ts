import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import readXlsxFile from "read-excel-file/node";
import { createApp } from "../src/server/http/http-server";
import {
  CursorApiClient,
  CursorApiError,
} from "../src/server/cursor/cursor-api";
import { configureInternalMcpServers } from "../src/contracts/mcp-origin";
import {
  SANKEY_MAX_LINK_WIDTH,
  SANKEY_MAX_NODE_HEIGHT,
} from "../src/app/relationships/mcp-relationship-graph";

configureInternalMcpServers("example-internal-mcp");

const servers = [
  ["github", ["search_code", "read_pull_request", "create_issue"]],
  ["slack", ["search_messages", "read_thread", "send_message"]],
  ["notion", ["search_pages", "fetch_page"]],
  ["atlassian", ["search_jira", "get_issue"]],
  ["figma", ["get_design_context", "get_screenshot"]],
  ["databricks", ["execute_sql", "get_table"]],
  ["example-internal-mcp", ["inspect_resource", "open_dialog"]],
] as const;

type MockMetric = {
  event_date: string;
  mcp_server_name: string;
  tool_name: string;
  usage: number;
};

const SMOKE_TEST_DATE = process.env.SMOKE_TEST_DATE ?? "2026-09-21";
if (!/^\d{4}-\d{2}-\d{2}$/.test(SMOKE_TEST_DATE)) {
  throw new Error("SMOKE_TEST_DATE must use YYYY-MM-DD format.");
}
const today = new Date(`${SMOKE_TEST_DATE}T00:00:00Z`);
if (
  Number.isNaN(today.getTime()) ||
  today.toISOString().slice(0, 10) !== SMOKE_TEST_DATE
) {
  throw new Error("SMOKE_TEST_DATE must be a valid calendar date.");
}
const daysAgo = (days: number) => {
  const date = new Date(today);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};
const start = new Date(`${daysAgo(91)}T00:00:00Z`);
const data: Record<string, MockMetric[]> = {};
for (let userIndex = 1; userIndex <= 50; userIndex += 1) {
  const email = `user${String(userIndex).padStart(2, "0")}@example.test`;
  data[email] = [];
  for (let day = 0; day < 90; day += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + day);
    for (let serverIndex = 0; serverIndex < servers.length; serverIndex += 1) {
      if ((userIndex + day + serverIndex) % (serverIndex + 2) !== 0) continue;
      const [server, tools] = servers[serverIndex];
      const tool = tools[(userIndex + day) % tools.length];
      data[email].push({
        event_date: date.toISOString().slice(0, 10),
        mcp_server_name: server,
        tool_name: tool,
        usage: ((userIndex * 7 + day * 3 + serverIndex) % 34) + 3,
      });
    }
  }
}

data["user01@example.test"].push(
  {
    event_date: daysAgo(81),
    mcp_server_name: "momentum-riser",
    tool_name: "compare",
    usage: 1,
  },
  {
    event_date: daysAgo(10),
    mcp_server_name: "momentum-riser",
    tool_name: "compare",
    usage: 900,
  },
  {
    event_date: daysAgo(80),
    mcp_server_name: "momentum-faller",
    tool_name: "compare",
    usage: 900,
  },
  {
    event_date: daysAgo(9),
    mcp_server_name: "momentum-faller",
    tool_name: "compare",
    usage: 1,
  },
  {
    event_date: daysAgo(79),
    mcp_server_name: "momentum-server-with-an-exceptionally-long-label",
    tool_name: "compare",
    usage: 1,
  },
  {
    event_date: daysAgo(8),
    mcp_server_name: "momentum-server-with-an-exceptionally-long-label",
    tool_name: "compare",
    usage: 850,
  },
);

for (let serverIndex = 0; serverIndex < 238; serverIndex += 1) {
  const email = `user${String((serverIndex % 50) + 1).padStart(2, "0")}@example.test`;
  for (let toolIndex = 0; toolIndex < 7; toolIndex += 1) {
    data[email].push({
      event_date: daysAgo(2),
      mcp_server_name: `mcp-${String(serverIndex + 1).padStart(3, "0")}`,
      tool_name: `tool-${String(serverIndex + 1).padStart(3, "0")}-${toolIndex + 1}`,
      usage: ((serverIndex + toolIndex) % 5) + 1,
    });
  }
}

let rejectAnalyticsRequests = false;
const mockFetch = async (input: string | URL | Request) => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const url = String(input);
  const teamMembers = Object.keys(data).map((email, index) => ({
    email,
    id: `user_${index + 1}`,
    name: `User ${String(index + 1).padStart(2, "0")}`,
    role: index < 3 ? "owner" : "member",
    isRemoved: false,
  }));
  if (url.includes("/teams/members")) {
    return new Response(JSON.stringify({ teamMembers }), { status: 200 });
  }
  if (url.includes("/teams/directory-groups/") && url.includes("/members")) {
    const even = url.includes("team_group_1");
    return new Response(
      JSON.stringify({
        members: teamMembers
          .filter((_, index) => (even ? index % 2 === 0 : index % 3 === 0))
          .map((member) => ({ userId: member.id, email: member.email })),
        pagination: { totalPages: 1, hasNextPage: false },
      }),
      { status: 200 },
    );
  }
  if (url.includes("/teams/directory-groups")) {
    return new Response(
      JSON.stringify({
        groups: [
          { id: "team_group_1", name: "Solutions" },
          { id: "team_group_2", name: "Pilot Program" },
        ],
        pagination: { totalPages: 1, hasNextPage: false },
      }),
      { status: 200 },
    );
  }
  if (rejectAnalyticsRequests) {
    return new Response("Synthetic analytics failure", { status: 503 });
  }
  const requestUrl = new URL(url);
  const startDate = requestUrl.searchParams.get("startDate") ?? "";
  const endDate = requestUrl.searchParams.get("endDate") ?? "";
  const windowData = Object.fromEntries(
    Object.entries(data).map(([email, rows]) => [
      email,
      rows.filter((row) => {
        const date = String(row.event_date ?? "");
        return date >= startDate && date <= endDate;
      }),
    ]),
  );
  return new Response(
    JSON.stringify({
      data: windowData,
      pagination: { totalPages: 1, hasNextPage: false },
      params: {
        userMappings: Object.keys(data).map((email, index) => ({
          email,
          id: `user_${index + 1}`,
        })),
        teamId: 4242,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const client = new CursorApiClient(
  "smoke-test-only",
  "https://mock.cursor.test",
  mockFetch,
);
const configuredApiKeys: string[] = [];
const app = createApp({
  setup: {
    allowed: true,
    configure: async (apiKey) => {
      if (!["smoke-test-only", "smoke-rotated"].includes(apiKey)) {
        throw new CursorApiError("Cursor API returned 401", 401);
      }
      configuredApiKeys.push(apiKey);
      return client;
    },
  },
  staticDir: "dist",
  loadTeamMetadata: true,
  teamName: "Example Team",
});
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as AddressInfo).port;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});

try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  await page.clock.setFixedTime(today);
  page.on("pageerror", (error) => {
    console.error(`Browser page error: ${error.stack ?? error.message}`);
  });
  page.setDefaultTimeout(10_000);
  await mkdir("artifacts", { recursive: true });
  await page.goto(
    `http://127.0.0.1:${port}?startDate=${daysAgo(91)}&endDate=${daysAgo(2)}`,
  );
  await page.getByRole("heading", { name: "Connect Cursor" }).waitFor();
  await page.screenshot({
    path: "artifacts/mcp-dashboard-setup.png",
    fullPage: true,
  });
  await page.getByLabel("Team Admin API key").fill("smoke-test-only");
  await page.getByRole("button", { name: "Connect dashboard" }).click();
  await page.getByRole("heading", { name: "Loading dashboard" }).waitFor();
  await page.waitForFunction(() => {
    const value = document
      .querySelector('[role="progressbar"]')
      ?.getAttribute("aria-valuenow");
    return Number(value) > 0;
  });
  await page.screenshot({
    path: "artifacts/mcp-dashboard-loading.png",
    fullPage: true,
  });
  await page.getByRole("heading", { name: /MCP adoption/i }).waitFor();
  await page
    .getByRole("heading", { name: "Loading dashboard" })
    .waitFor({ state: "hidden" });
  if ((await page.locator(".loading-modal").count()) !== 0) {
    throw new Error("Dashboard rendered an extra loading modal after setup");
  }
  await page
    .getByRole("region", { name: "MCP adoption summary" })
    .getByText("Observed MCP calls", { exact: true })
    .waitFor();
  if ((await page.getByRole("button", { name: /^Select/ }).count()) < 2) {
    throw new Error("Selection actions are missing from dashboard visuals");
  }
  if ((await page.locator(".status-pill").count()) !== 0) {
    throw new Error("Deprecated live-data badge is still visible");
  }
  const defaultOriginSelection = page
    .locator(".selection-bar")
    .getByRole("button", { name: "Open MCP type filter external" });
  await defaultOriginSelection.waitFor();
  if (
    !(await page
      .locator(".selection-bar")
      .getByRole("button", { name: "Clear selections" })
      .isDisabled())
  ) {
    throw new Error(
      "Clear selections should preserve the default locked MCP type",
    );
  }
  await page.getByRole("button", { name: /^Filters/ }).click();
  const stickyFilters = page.locator("#sticky-filter-workspace");
  await stickyFilters.getByRole("button", { name: /^MCP type/ }).click();
  const lockedOriginMenu = page.locator(".multi-filter-menu");
  await lockedOriginMenu
    .getByRole("button", { name: "Unlock MCP type selection" })
    .waitFor();
  if (
    !(await lockedOriginMenu
      .getByRole("option", { name: /External/ })
      .isDisabled())
  ) {
    throw new Error("Locked selector values should not be editable");
  }
  await stickyFilters.getByRole("button", { name: /^MCP type/ }).click();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await defaultOriginSelection.click();
  const reopenedOriginMenu = page.locator(".multi-filter-menu");
  await reopenedOriginMenu
    .getByRole("button", { name: "Unlock MCP type selection" })
    .click();
  await stickyFilters.getByRole("button", { name: /^MCP type/ }).click();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Remove MCP type filter external" })
    .click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  const topbarButtonStyles = await page
    .locator(".topbar-button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          width: box.width,
          height: box.height,
          background: style.backgroundImage,
          radius: style.borderRadius,
          fontSize: style.fontSize,
        };
      }),
    );
  if (
    topbarButtonStyles.length !== 2 ||
    topbarButtonStyles.some((styles) => styles.width < 80 || styles.height < 38)
  ) {
    throw new Error("Topbar action styling is incorrect");
  }
  const controlDeckLayout = await page
    .locator(".control-deck")
    .evaluate((deck) => {
      const date = deck.querySelector(".date-control")?.getBoundingClientRect();
      const search = deck
        .querySelector(".global-search")
        ?.getBoundingClientRect();
      const filters = [
        ...deck.querySelectorAll(
          ".filter-controls > .multi-filter, .filter-controls > .temporal-filter-group",
        ),
      ].map((element) => element.getBoundingClientRect());
      return {
        topRowsOverlap: Boolean(date && search && date.right > search.left + 1),
        filterCount: filters.length,
        filterRowSpread:
          filters.length > 0
            ? Math.max(...filters.map((box) => box.top)) -
              Math.min(...filters.map((box) => box.top))
            : Infinity,
        overflow: deck.scrollWidth - deck.clientWidth,
      };
    });
  if (
    controlDeckLayout.topRowsOverlap ||
    controlDeckLayout.filterCount !== 0 ||
    controlDeckLayout.filterRowSpread !== Infinity ||
    controlDeckLayout.overflow > 1
  ) {
    throw new Error(
      `Control deck layout is unbalanced: ${JSON.stringify(controlDeckLayout)}`,
    );
  }
  const expandedRangeResponse = page.waitForResponse((response) =>
    response.url().includes(`startDate=${daysAgo(100)}`),
  );
  await page.getByLabel("Start date").fill(daysAgo(100));
  await page.locator(".loading-layer").waitFor({ state: "visible" });
  await expandedRangeResponse;
  await page.locator(".loading-layer").waitFor({ state: "hidden" });
  await page
    .locator(".preset-group")
    .getByRole("button", { name: "30D" })
    .click();
  const activeRangeBeforeFailure = {
    start: await page.getByLabel("Start date").inputValue(),
    end: await page.getByLabel("End date").inputValue(),
  };
  rejectAnalyticsRequests = true;
  const failedRangeResponse = page.waitForResponse((response) =>
    response.url().includes(`startDate=${daysAgo(120)}`),
  );
  await page.getByLabel("Start date").fill(daysAgo(120));
  await page.locator(".loading-layer").waitFor({ state: "visible" });
  const failedRange = await failedRangeResponse;
  rejectAnalyticsRequests = false;
  await page.locator(".loading-layer").waitFor({ state: "hidden" });
  if (
    failedRange.status() !== 502 ||
    (await page.getByLabel("Start date").inputValue()) !==
      activeRangeBeforeFailure.start ||
    (await page.getByLabel("End date").inputValue()) !==
      activeRangeBeforeFailure.end
  ) {
    throw new Error("Failed range load did not restore the active date window");
  }
  const rangeRetry = page.waitForResponse((response) =>
    response.url().includes(`startDate=${daysAgo(120)}`),
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await rangeRetry;
  await page.locator(".loading-layer").waitFor({ state: "hidden" });
  await page
    .locator(".preset-group")
    .getByRole("button", { name: "30D" })
    .click();
  const rangeBeforeCredentialRefresh = {
    start: await page.getByLabel("Start date").inputValue(),
    end: await page.getByLabel("End date").inputValue(),
  };
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Connection" }).waitFor();
  await page.screenshot({
    path: "artifacts/mcp-dashboard-settings.png",
    fullPage: true,
  });
  await page.getByLabel("Replace API key").fill("smoke-rotated");
  const rotationRefresh = page.waitForResponse((response) =>
    response.url().includes("refresh=1"),
  );
  await page.getByRole("button", { name: "Validate and replace" }).click();
  await rotationRefresh;
  await page.getByRole("heading", { name: "Connection" }).waitFor({
    state: "hidden",
  });
  await page.locator(".loading-layer").waitFor({ state: "hidden" });
  if (
    (await page.getByLabel("Start date").inputValue()) !==
      rangeBeforeCredentialRefresh.start ||
    (await page.getByLabel("End date").inputValue()) !==
      rangeBeforeCredentialRefresh.end
  ) {
    throw new Error("Credential refresh changed the active date window");
  }
  if (configuredApiKeys.join(",") !== "smoke-test-only,smoke-rotated") {
    throw new Error(
      `API key rotation did not reach the server: ${configuredApiKeys.join(",")}`,
    );
  }
  await page
    .locator(".preset-group")
    .getByRole("button", { name: "90D" })
    .click();
  await page.getByText("Last refreshed", { exact: true }).waitFor();
  const refreshResponse = page.waitForResponse((response) =>
    response.url().includes("refresh=1"),
  );
  await page.getByRole("button", { name: "Refresh" }).click();
  if (await page.locator(".loading-layer").isVisible()) {
    throw new Error("Background refresh unexpectedly blocked the dashboard");
  }
  await refreshResponse;
  await page.locator(".loading-layer").waitFor({ state: "hidden" });
  await page.getByText(/Example Team · 50 members · 2 groups/).waitFor();
  const modeNav = page.locator(".dar-nav");
  for (const mode of ["Dashboard", "Analysis", "Reporting"]) {
    await modeNav.getByRole("button", { name: mode, exact: true }).waitFor();
  }
  if (
    (await modeNav
      .getByRole("button", { name: "Dashboard", exact: true })
      .getAttribute("aria-pressed")) !== "true" ||
    !(await page.locator(".network-panel").isVisible()) ||
    !(await page.locator(".user-mcp-inventory").isVisible())
  ) {
    throw new Error("Dashboard sections are not all available");
  }

  const momentumPanel = page.locator(".momentum-panel");
  await momentumPanel.getByRole("heading", { name: "MCP momentum" }).waitFor();
  const momentumSubtitle = await momentumPanel
    .locator(".panel-heading p")
    .textContent();
  const formatFixtureDate = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  if (
    !momentumSubtitle?.includes(formatFixtureDate(daysAgo(1))) ||
    momentumSubtitle.includes(formatFixtureDate(daysAgo(0)))
  ) {
    throw new Error("Momentum comparison included the incomplete current day");
  }
  const risingMomentum = momentumPanel.getByRole("button", {
    name: /momentum-riser MCP filter/i,
  });
  const fallingMomentum = momentumPanel.getByRole("button", {
    name: /momentum-faller MCP filter/i,
  });
  const longMomentumLabel = momentumPanel.getByTitle(
    "momentum-server-with-an-exceptionally-long-label",
  );
  if (
    !(await risingMomentum.getAttribute("aria-label"))?.includes(
      "Earlier period 1 calls. Current period 900 calls.",
    ) ||
    !(await fallingMomentum.getAttribute("aria-label"))?.includes(
      "Earlier period 900 calls. Current period 1 calls.",
    )
  ) {
    throw new Error("Momentum periods or direction labels are incorrect");
  }
  await longMomentumLabel.waitFor();
  await risingMomentum.click();
  if (
    (await risingMomentum.getAttribute("aria-pressed")) !== "true" ||
    (await page.locator(".scope-chip.server").count()) !== 0
  ) {
    throw new Error("Momentum selection was committed before confirmation");
  }
  await page.waitForFunction(() => {
    const row = document.querySelector<HTMLElement>(
      '[title="momentum-faller"]',
    );
    return row && Number(getComputedStyle(row).opacity) <= 0.4;
  });
  const [selectedOpacity, unselectedOpacity] = await Promise.all([
    risingMomentum.evaluate((row) => Number(getComputedStyle(row).opacity)),
    fallingMomentum.evaluate((row) => Number(getComputedStyle(row).opacity)),
  ]);
  if (selectedOpacity < 0.95 || unselectedOpacity > 0.4) {
    throw new Error("Momentum selection did not de-emphasize unselected rows");
  }
  await page.getByRole("button", { name: "Apply pending selections" }).click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  if (
    (await page.locator(".scope-chip.server").count()) !== 1 ||
    (await risingMomentum.getAttribute("aria-pressed")) !== "true"
  ) {
    throw new Error("Momentum selection did not commit");
  }
  await risingMomentum.click();
  await page.keyboard.press("Escape");
  if ((await risingMomentum.getAttribute("aria-pressed")) !== "true") {
    throw new Error(
      "Momentum selection cancel did not restore committed state",
    );
  }
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: /Remove MCP filter momentum-riser/i })
    .click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });

  const desktopMomentumHeight = await momentumPanel.evaluate(
    (panel) => panel.getBoundingClientRect().height,
  );
  const activityPanelHeight = await page
    .locator(".trend-panel")
    .evaluate((panel) => panel.getBoundingClientRect().height);
  if (desktopMomentumHeight > activityPanelHeight + 1) {
    throw new Error(
      `Momentum panel is too tall: ${desktopMomentumHeight}px vs ${activityPanelHeight}px`,
    );
  }
  await momentumPanel.screenshot({
    path: "artifacts/mcp-dashboard-momentum.png",
  });

  await page.setViewportSize({ width: 821, height: 900 });
  const wideMomentumColumns = await page
    .locator(".momentum-lanes")
    .evaluate((lanes) => getComputedStyle(lanes).gridTemplateColumns);
  await page.setViewportSize({ width: 820, height: 900 });
  const stackedMomentumColumns = await page
    .locator(".momentum-lanes")
    .evaluate((lanes) => getComputedStyle(lanes).gridTemplateColumns);
  await page.setViewportSize({ width: 560, height: 900 });
  const compactMomentumGeometry = await momentumPanel.evaluate((panel) => ({
    overflow: panel.scrollWidth - panel.clientWidth,
    railsHidden: [
      ...panel.querySelectorAll<HTMLElement>(".momentum-rail"),
    ].every((rail) => getComputedStyle(rail).display === "none"),
    selectHeight:
      panel.querySelector(".selection-actions-trigger")?.getBoundingClientRect()
        .height ?? 0,
  }));
  await momentumPanel.screenshot({
    path: "artifacts/mcp-dashboard-momentum-mobile.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowMomentumOverflow = await momentumPanel.evaluate(
    (panel) => panel.scrollWidth - panel.clientWidth,
  );
  const mobileHeaderControlsAreUntabbable = await page
    .locator(".inventory-table thead button")
    .evaluateAll((controls) =>
      controls.every((control) => control.tabIndex === -1),
    );
  await momentumPanel.screenshot({
    path: "artifacts/mcp-dashboard-momentum-narrow.png",
  });
  if (
    wideMomentumColumns.trim().split(/\s+/).length !== 2 ||
    stackedMomentumColumns.trim().split(/\s+/).length !== 1 ||
    compactMomentumGeometry.overflow > 1 ||
    !compactMomentumGeometry.railsHidden ||
    compactMomentumGeometry.selectHeight < 44 ||
    narrowMomentumOverflow > 1 ||
    !mobileHeaderControlsAreUntabbable
  ) {
    throw new Error(
      `Momentum responsive layout failed: ${JSON.stringify({
        wideMomentumColumns,
        stackedMomentumColumns,
        compactMomentumGeometry,
        narrowMomentumOverflow,
      })}`,
    );
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".inventory-table thead button",
      ),
    ].every((control) => control.tabIndex === 0),
  );

  await modeNav.getByRole("button", { name: "Reporting", exact: true }).click();
  const inventory = page.getByRole("region", {
    name: "User–MCP report",
    exact: true,
  });
  await inventory.getByRole("heading", { name: "User–MCP report" }).waitFor();
  if (
    (await page
      .locator(".topbar")
      .getByRole("button", { name: /Export/i })
      .count()) > 0 ||
    (await inventory
      .getByRole("button", { name: /Export|Copy TSV|Copy emails/i })
      .count()) > 0 ||
    (await page
      .locator("#pivot-workspace")
      .getByRole("button", { name: /Pivot CSV/i })
      .count()) > 0
  ) {
    throw new Error(
      "Duplicate export controls remain outside the export center",
    );
  }
  const filterWorkspace = page.locator("#sticky-filter-workspace");
  const openFilterWorkspace = async () => {
    if (!(await filterWorkspace.isVisible())) {
      await page.getByRole("button", { name: /^Filters/ }).click();
      await filterWorkspace.waitFor();
    }
  };
  await openFilterWorkspace();
  const globalMcpTrigger = filterWorkspace.getByRole("button", {
    name: /^MCPs/,
  });
  await globalMcpTrigger.click();
  const globalMcpMenu = page.locator(".multi-filter-menu");
  await globalMcpMenu.getByRole("option", { name: /^slack/i }).click();
  await globalMcpMenu.getByRole("option", { name: /^atlassian/i }).click();
  await globalMcpTrigger.click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  const matchedUsersKpi = inventory
    .locator(".inventory-kpis > div")
    .filter({ hasText: "Matched users" })
    .locator("strong");
  await matchedUsersKpi.waitFor();
  if (
    (await matchedUsersKpi.textContent()) !== "50" ||
    (await page.locator(".selection-bar .scope-chip.server").count()) !== 2
  ) {
    throw new Error("Inventory did not mirror the two-MCP global scope");
  }

  const visibleInventoryRows = await inventory
    .locator(".inventory-table tbody tr")
    .count();
  const exportTrigger = page
    .locator(".selection-bar")
    .getByRole("button", { name: "Export current scope" });
  await exportTrigger.click();
  const exportCenter = page.getByRole("dialog", {
    name: "Export current scope",
  });
  await exportCenter.waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "Close export center",
  );
  await page.keyboard.press("Shift+Tab");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-controls") ===
      "scope-export-panel",
  );
  await page.keyboard.press("Tab");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "Close export center",
  );
  await exportCenter
    .getByRole("button", { name: /User–MCP report.*CSV.*TSV.*XLSX/i })
    .click();
  const formatDialog = page.getByRole("dialog", {
    name: "User–MCP report",
  });
  await formatDialog
    .getByRole("radio", { name: /TSV/i })
    .check({ force: true });
  const inventoryDownload = page.waitForEvent("download");
  await formatDialog.getByRole("button", { name: "Download TSV" }).click();
  await page.waitForFunction(
    () =>
      document.activeElement?.textContent?.includes("Export current scope") ??
      false,
  );
  const downloadedInventory = await inventoryDownload;
  if (!downloadedInventory.suggestedFilename().endsWith(".tsv")) {
    throw new Error("User–MCP report did not download a TSV");
  }
  const inventoryPath = await downloadedInventory.path();
  if (!inventoryPath) throw new Error("Inventory TSV path unavailable");
  const inventoryTsv = await readFile(inventoryPath, "utf8");
  const inventoryLines = inventoryTsv.trim().split("\n");
  const inventoryHeaderIndex = inventoryLines.findIndex((line) =>
    line.startsWith("display_name\t"),
  );
  if (
    inventoryHeaderIndex !== 0 ||
    !inventoryLines[inventoryHeaderIndex].includes("last_observed") ||
    !inventoryTsv.includes("\tslack\t") ||
    !inventoryTsv.includes("\tatlassian\t") ||
    inventoryLines.length - inventoryHeaderIndex - 1 <= visibleInventoryRows ||
    inventoryLines.some(
      (line) =>
        line.split("\t").length !== inventoryLines[0].split("\t").length,
    )
  ) {
    throw new Error("Inventory TSV did not contain every matching row");
  }
  await exportTrigger.click();
  await exportCenter
    .getByRole("button", {
      name: /Export user email addresses.*CSV.*TSV.*XLSX/i,
    })
    .click();
  const emailFormatDialog = page.getByRole("dialog", {
    name: "User email addresses",
  });
  await emailFormatDialog
    .getByRole("radio", { name: /TSV/i })
    .check({ force: true });
  const emailDownload = page.waitForEvent("download");
  await emailFormatDialog.getByRole("button", { name: "Download TSV" }).click();
  const downloadedEmails = await emailDownload;
  if (!downloadedEmails.suggestedFilename().endsWith(".tsv")) {
    throw new Error("User emails did not download as TSV");
  }
  const emailPath = await downloadedEmails.path();
  if (!emailPath) throw new Error("Email TSV path unavailable");
  const emailLines = (await readFile(emailPath, "utf8")).trim().split("\n");
  const emailHeaderIndex = emailLines.indexOf("email");
  const exportedEmailRows = emailLines.slice(emailHeaderIndex + 1);
  if (
    emailHeaderIndex !== 0 ||
    exportedEmailRows.length !== 50 ||
    new Set(exportedEmailRows).size !== 50
  ) {
    throw new Error("Email TSV did not contain 50 unique scoped addresses");
  }
  const exportedServers = await inventory
    .locator(".inventory-table tbody .mcp-server-value")
    .allTextContents();
  if (
    exportedServers.some(
      (server) => server !== "slack" && server !== "atlassian",
    )
  ) {
    throw new Error("Inventory ignored the global MCP filter");
  }
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear selections" })
    .click();
  await page.locator(".clear-scope-transition").waitFor();
  if (await page.locator(".loading-layer").isVisible()) {
    throw new Error("Clear selections triggered the blocking loading overlay");
  }
  await page.locator(".clear-scope-transition").waitFor({ state: "hidden" });
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  await inventory.locator(".inventory-table tbody tr").first().waitFor();

  await page.setViewportSize({ width: 540, height: 900 });
  const mobileInventoryGeometry = await inventory.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    return {
      left: box.left,
      right: box.right,
      viewport,
      documentOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      outside: [...element.querySelectorAll<HTMLElement>("*")]
        .filter((child) => {
          const childBox = child.getBoundingClientRect();
          return childBox.left < -2 || childBox.right > viewport + 2;
        })
        .map((child) => ({
          className: child.className,
          left: child.getBoundingClientRect().left,
          right: child.getBoundingClientRect().right,
        }))
        .slice(0, 8),
    };
  });
  if (
    mobileInventoryGeometry.left < -2 ||
    mobileInventoryGeometry.right > mobileInventoryGeometry.viewport + 2 ||
    mobileInventoryGeometry.outside.length > 0
  ) {
    throw new Error(
      `Inventory mobile geometry failed: ${JSON.stringify(mobileInventoryGeometry)}`,
    );
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await modeNav.getByRole("button", { name: "Dashboard", exact: true }).click();

  await openFilterWorkspace();
  await filterWorkspace.getByRole("button", { name: /^Groups/ }).click();
  const groupFilter = page.locator(".multi-filter-menu");
  await groupFilter.getByPlaceholder("Search groups…").fill("Pilot");
  await groupFilter.getByRole("option", { name: /Pilot Program/ }).click();
  await filterWorkspace.getByRole("button", { name: /^Groups/ }).click();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: /Remove group filter/i })
    .waitFor();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear selections" })
    .click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  const originTrigger = filterWorkspace.getByRole("button", {
    name: /^MCP type/,
  });
  await originTrigger.click();
  const originFilter = page.locator(".multi-filter-menu");
  await originFilter.getByRole("option", { name: /Internal/ }).click();
  await originTrigger.click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  if (
    (await page.locator(".server-ranking .internal-mcp-badge").count()) === 0
  ) {
    throw new Error("Internal MCP values are missing visual badges");
  }
  await filterWorkspace.getByRole("button", { name: /^MCPs/ }).click();
  const internalServerOption = page
    .locator(".multi-filter-menu")
    .getByRole("option", { name: /example-internal-mcp/i });
  await internalServerOption.locator(".internal-mcp-badge").waitFor();
  await filterWorkspace.getByRole("button", { name: /^MCPs/ }).click();
  await page
    .getByRole("button", { name: /Remove MCP type filter internal/i })
    .click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  const timeTrigger = filterWorkspace.getByRole("button", { name: /^Time/ });
  await page.setViewportSize({ width: 390, height: 800 });
  await timeTrigger.click();
  const shortViewportTemporalMenu = page.locator(".temporal-group-menu");
  const dateFilter = shortViewportTemporalMenu
    .locator(".temporal-subfilters .multi-filter")
    .first();
  await dateFilter.locator(".multi-filter-trigger").click();
  const dateMenu = dateFilter.locator(".multi-filter-menu");
  await dateMenu
    .getByRole("option")
    .first()
    .evaluate((option: HTMLButtonElement) => option.click());
  const dateMenuGeometry = await dateMenu.evaluate((menu) => {
    const bounds = menu.getBoundingClientRect();
    const footer = menu.querySelector<HTMLElement>(".multi-filter-footer");
    const footerBounds = footer?.getBoundingClientRect();
    const clippedHeaderControls = [
      ...menu.querySelectorAll<HTMLButtonElement>(".multi-filter-head button"),
    ]
      .map((button) => {
        const buttonBounds = button.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label") ?? button.textContent,
          left: buttonBounds.left,
          right: buttonBounds.right,
          top: buttonBounds.top,
          bottom: buttonBounds.bottom,
          clipped:
            buttonBounds.left < bounds.left - 1 ||
            buttonBounds.right > bounds.right + 1 ||
            buttonBounds.top < bounds.top - 1 ||
            buttonBounds.bottom > bounds.bottom + 1,
        };
      })
      .filter((button) => button.clipped);
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      footerBottom: footerBounds?.bottom ?? Number.POSITIVE_INFINITY,
      clippedHeaderControls,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  if (
    dateMenuGeometry.left < 0 ||
    dateMenuGeometry.right > dateMenuGeometry.viewportWidth ||
    dateMenuGeometry.top < 0 ||
    dateMenuGeometry.bottom > dateMenuGeometry.viewportHeight ||
    dateMenuGeometry.footerBottom > dateMenuGeometry.bottom ||
    dateMenuGeometry.clippedHeaderControls.length > 0
  ) {
    throw new Error(
      `Date filter escaped the viewport: ${JSON.stringify(dateMenuGeometry)}`,
    );
  }
  await dateMenu
    .getByRole("button", { name: "Cancel pending selections" })
    .click();
  await timeTrigger.click();
  await page.setViewportSize({ width: 1600, height: 1000 });

  await timeTrigger.click();
  const temporalMenu = page.locator(".temporal-group-menu");
  const temporalFilters = temporalMenu.locator(
    ".temporal-subfilters .multi-filter",
  );
  const yearFilter = temporalFilters.nth(6);
  const yearFilterTrigger = yearFilter.locator(".multi-filter-trigger");
  await yearFilterTrigger.click();
  await yearFilter
    .locator(".multi-filter-menu")
    .getByRole("option")
    .first()
    .click();
  await yearFilterTrigger.click();
  const monthFilter = temporalFilters.nth(3);
  const monthFilterTrigger = monthFilter.locator(".multi-filter-trigger");
  await monthFilterTrigger.click();
  await monthFilter
    .locator(".multi-filter-menu")
    .getByRole("option")
    .first()
    .click();
  await monthFilterTrigger.click();
  await timeTrigger.click();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear Year selections" })
    .waitFor();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear Month selections" })
    .waitFor();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear selections" })
    .click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  for (const label of [
    "Explore Observed MCP calls",
    "Explore Active users",
    "Explore Observed MCPs",
    "Explore MCP–tool pairs",
  ]) {
    await page.getByRole("button", { name: label }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator(".drawer-scope-panel").waitFor();
    await dialog.getByRole("button", { name: "Clear selections" }).waitFor();
    await dialog.getByRole("button", { name: /^Select/ }).waitFor();
    if ((await dialog.locator(".drawer-filter-controls").count()) !== 1) {
      throw new Error("Drawer is missing persistent scope controls");
    }
    await page.getByRole("button", { name: "Close KPI details" }).click();
  }
  await page.getByRole("button", { name: "Explore MCP–tool pairs" }).click();
  const toolRows = page.getByRole("dialog").locator(".kpi-detail-row");
  await toolRows.first().waitFor();
  if (
    (await toolRows.count()) === 0 ||
    (await page
      .getByRole("dialog")
      .locator(".kpi-detail-row.interactive")
      .count()) !== 0
  ) {
    throw new Error("MCP–tool pairs exposed a misleading tool-only selection");
  }
  await page.getByRole("button", { name: "Close KPI details" }).click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });

  await page.getByLabel("Daily measure").selectOption("users");
  await page
    .getByRole("group", { name: /^Daily distinct users trend/ })
    .waitFor();
  const renderedPointTitles = await page
    .locator(".trend-panel .chart-point.visual title")
    .allTextContents();
  if (
    renderedPointTitles.length === 0 ||
    renderedPointTitles.some((title) => /:\s*0\s+distinct users$/.test(title))
  ) {
    throw new Error("Trend rendered zero-value points");
  }
  const tooltipPoint = page
    .locator(".trend-panel .chart-point.interactive")
    .nth(10);
  await page.mouse.move(0, 0);
  await tooltipPoint.hover({ force: true });
  const trendTooltip = page.locator(".trend-panel .trend-point-tooltip");
  await trendTooltip.waitFor();
  if (!/distinct users/i.test((await trendTooltip.textContent()) ?? "")) {
    throw new Error("Trend tooltip did not describe the selected measure");
  }
  await page.getByLabel("Show values").check();
  if ((await page.locator(".trend-panel .chart-point-value").count()) === 0) {
    throw new Error("Show values did not render point labels");
  }
  await page.getByLabel("Show values").uncheck();
  if ((await page.locator(".trend-panel .chart-point-value").count()) !== 0) {
    throw new Error("Point labels remained after disabling Show values");
  }

  await page
    .locator(".preset-group")
    .getByRole("button", { name: "30D" })
    .click();
  await page.locator(".loading-layer").waitFor({ state: "hidden" });
  const loadedRangeBeforePointSelection = {
    start: await page.getByLabel("Start date").inputValue(),
    end: await page.getByLabel("End date").inputValue(),
  };
  const chartPoints = page.locator(".trend-panel .chart-point.interactive");
  const dayPoint = chartPoints.nth(5);
  const dayLabel = await dayPoint.getAttribute("aria-label");
  const selectedDay = dayLabel?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!selectedDay)
    throw new Error("Chart point is missing an accessible date");
  const brush = page.locator(".trend-panel .chart-brush .overlay");
  const brushBox = await brush.boundingBox();
  if (!brushBox) throw new Error("Chart range selector is unavailable");
  await dayPoint.focus();
  await page.keyboard.press("Space");
  if ((await dayPoint.getAttribute("aria-pressed")) !== "true") {
    throw new Error("Chart point did not show its selected state");
  }
  await page
    .getByRole("toolbar", { name: "Pending selections" })
    .getByText("1 pending change")
    .waitFor();
  const secondPointIndex = 8;
  const secondDayLabel = await chartPoints
    .nth(secondPointIndex)
    .getAttribute("aria-label");
  const secondDay = secondDayLabel?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!secondDay) throw new Error("Second chart point is missing a date");
  await chartPoints.nth(secondPointIndex).focus();
  await page.keyboard.press("Space");
  if (
    (await chartPoints.nth(secondPointIndex).getAttribute("aria-pressed")) !==
    "true"
  ) {
    throw new Error("Chart points did not preserve multiple date selections");
  }
  await page.keyboard.press("Enter");
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear Date selections" })
    .waitFor();
  if (
    (await page
      .locator(".selection-bar")
      .getByRole("button", { name: "Clear Date selections" })
      .count()) !== 1 ||
    !(
      await page
        .locator(".selection-bar")
        .getByRole("button", { name: "Open Date selections" })
        .textContent()
    )?.includes("2 selected")
  ) {
    throw new Error("Enter did not apply multiple date selections");
  }
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Open Date selections" })
    .click();
  const dateSelectionMenu = page.locator(".multi-filter-menu");
  await dateSelectionMenu.waitFor();
  if (
    (await dateSelectionMenu
      .getByRole("option", { selected: true })
      .count()) !== 2
  ) {
    throw new Error("Grouped Date chip did not reopen its selected values");
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const path = document
      .querySelector<SVGPathElement>(".trend-panel .chart-line")
      ?.getAttribute("d");
    return (path?.match(/M/g) ?? []).length === 1;
  });
  if (
    (await page.getByLabel("Start date").inputValue()) !==
      loadedRangeBeforePointSelection.start ||
    (await page.getByLabel("End date").inputValue()) !==
      loadedRangeBeforePointSelection.end
  ) {
    throw new Error("Date point confirmation changed the loaded date window");
  }
  const globalReset = page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear selections" });
  if (await globalReset.isDisabled()) {
    throw new Error("Global reset is unavailable for chart selections");
  }
  await globalReset.click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>(".selection-bar .global-reset")
        ?.disabled === true,
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".trend-panel .chart-point").length > 10,
  );

  const resetBrushBox = await brush.boundingBox();
  if (!resetBrushBox) throw new Error("Chart range selector is unavailable");
  const rangeBeforeBrush = {
    start: await page.getByLabel("Start date").inputValue(),
    end: await page.getByLabel("End date").inputValue(),
  };
  const callsBeforeBrush = await page
    .locator(".kpi-card .kpi-value")
    .first()
    .textContent();
  await brush.dragTo(brush, {
    sourcePosition: {
      x: resetBrushBox.width * 0.2,
      y: resetBrushBox.height / 2,
    },
    targetPosition: {
      x: resetBrushBox.width * 0.45,
      y: resetBrushBox.height / 2,
    },
  });
  const draftedBrushDates = await page
    .locator('.trend-panel .chart-point[aria-pressed="true"]')
    .count();
  if (
    draftedBrushDates < 2 ||
    (await page.getByLabel("Start date").inputValue()) !==
      rangeBeforeBrush.start ||
    (await page.getByLabel("End date").inputValue()) !== rangeBeforeBrush.end ||
    (await page.locator(".kpi-card .kpi-value").first().textContent()) !==
      callsBeforeBrush
  ) {
    throw new Error("Chart drag changed the dashboard before confirmation");
  }
  await page.keyboard.press("Escape");
  if (
    (await page
      .locator('.trend-panel .chart-point[aria-pressed="true"]')
      .count()) !== 0
  ) {
    throw new Error("Escape did not cancel brushed date selections");
  }
  await brush.dragTo(brush, {
    sourcePosition: {
      x: resetBrushBox.width * 0.2,
      y: resetBrushBox.height / 2,
    },
    targetPosition: {
      x: resetBrushBox.width * 0.45,
      y: resetBrushBox.height / 2,
    },
  });
  const brushPendingText =
    (await page
      .getByRole("toolbar", { name: "Pending selections" })
      .textContent()) ?? "";
  const confirmedBrushDates = Number(
    brushPendingText.match(/(\d+)\s+pending/)?.[1] ?? 0,
  );
  if (confirmedBrushDates === 0) {
    throw new Error("Brush did not draft any date selections");
  }
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (previous) =>
      document.querySelector(".kpi-card .kpi-value")?.textContent !== previous,
    callsBeforeBrush,
  );
  const timeSelectionCount = Number(
    await filterWorkspace
      .getByRole("button", { name: /^Time/ })
      .locator("strong")
      .textContent(),
  );
  if (timeSelectionCount !== confirmedBrushDates) {
    throw new Error("Confirmed brush dates did not reach the Time selector");
  }
  if (
    (await page
      .locator('.trend-panel .chart-point[aria-pressed="true"]')
      .count()) === 0
  ) {
    throw new Error("Line chart did not preserve committed date states");
  }
  await globalReset.click();

  const globalSearch = page.locator(".control-deck").getByRole("combobox", {
    name: "Search users, MCPs, tools, and groups",
  });
  await globalSearch.fill("atlas");
  await page
    .locator(".control-deck .search-apply-hint")
    .getByText(/Filtering activity by “atlas”/i)
    .waitFor();
  await globalSearch.press("Escape");
  await page.locator(".control-deck .search-results").waitFor({
    state: "hidden",
  });
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  const partialSearchChip = page
    .locator(".selection-bar")
    .getByRole("button", { name: "Remove search filter atlas" });
  await partialSearchChip.waitFor();
  if ((await page.locator(".scope-chip.server").count()) !== 0) {
    throw new Error("Partial search collapsed into an exact MCP selection");
  }
  await modeNav.getByRole("button", { name: "Reporting", exact: true }).click();
  const partialServerCells = inventory.locator(
    ".inventory-table tbody .mcp-server-value",
  );
  await partialServerCells.first().waitFor();
  const partialSearchServers = await partialServerCells.allTextContents();
  if (
    partialSearchServers.length === 0 ||
    partialSearchServers.some(
      (server) => !server.toLowerCase().includes("atlas"),
    )
  ) {
    throw new Error("Partial search did not retain every matching record");
  }
  await modeNav.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Open search filter atlas" })
    .click();
  await page.locator(".sticky-filter-workspace .search-results").waitFor();
  if (
    (await globalSearch.inputValue()) !== "atlas" ||
    (await page.locator(".scope-chip.query").count()) !== 1
  ) {
    throw new Error("Opening a scope chip removed or changed its selection");
  }
  await partialSearchChip.click();
  await page.getByRole("button", { name: "Close sticky filters" }).click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  await globalSearch.fill("github");
  await page
    .locator(".search-results")
    .getByRole("option", { name: /github/i })
    .click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  await openFilterWorkspace();
  await filterWorkspace.getByRole("button", { name: /^MCPs/ }).click();
  await page
    .locator(".multi-filter-menu")
    .getByRole("button", { name: "Lock MCPs selection" })
    .click();
  await filterWorkspace.getByRole("button", { name: /^MCPs/ }).click();
  if (
    !(await page
      .locator(".selection-bar")
      .getByRole("button", { name: "Clear selections" })
      .isDisabled())
  ) {
    throw new Error("Clear selections should not clear a locked MCP selection");
  }
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Open MCP filter github" })
    .click();
  const reopenedMcpMenu = page.locator(".multi-filter-menu");
  await reopenedMcpMenu
    .getByRole("button", { name: "Unlock MCPs selection" })
    .click();
  await filterWorkspace.getByRole("button", { name: /^MCPs/ }).click();
  const githubRank = page
    .locator(".server-ranking")
    .getByRole("button", { name: /github MCP filter/i });
  if ((await githubRank.getAttribute("aria-pressed")) !== "true") {
    throw new Error("Ranking did not expose the committed MCP selection");
  }
  await githubRank.click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  if (
    (await page.locator(".scope-chip.server").count()) !== 1 ||
    (await githubRank.getAttribute("aria-pressed")) !== "false"
  ) {
    throw new Error("Ranking did not preview MCP removal");
  }
  await page.getByRole("button", { name: "Apply pending selections" }).click();
  if ((await page.locator(".scope-chip.server").count()) !== 0) {
    throw new Error("Ranking apply did not remove the selected MCP");
  }
  await githubRank.click();
  await page.getByRole("button", { name: "Apply pending selections" }).click();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: /Remove MCP filter github/i })
    .waitFor();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: /Remove MCP filter github/i })
    .click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });

  await filterWorkspace.getByRole("button", { name: /^Users/ }).click();
  const userFilter = page.locator(".multi-filter-menu");
  const filterHeaderVisible = await userFilter
    .locator(".multi-filter-head")
    .evaluate((header) => {
      const box = header.getBoundingClientRect();
      const topElement = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return Boolean(topElement && header.contains(topElement));
    });
  if (!filterHeaderVisible) {
    throw new Error("Filter menu header is obscured by another stacking layer");
  }
  await userFilter.getByRole("button", { name: "A–Z" }).click();
  const alphabeticalUsers = await userFilter
    .locator(".filter-option-copy > strong")
    .allTextContents();
  const expectedAlphabeticalUsers = [...alphabeticalUsers].sort((a, b) =>
    a.localeCompare(b),
  );
  if (
    alphabeticalUsers.join("\u0000") !==
    expectedAlphabeticalUsers.join("\u0000")
  ) {
    throw new Error("Filter A–Z sorting is incorrect");
  }
  await userFilter.getByRole("button", { name: "Associated calls" }).click();
  const userSearch = userFilter.getByPlaceholder("Search users…");
  await userSearch.fill("user01");
  await userFilter.getByRole("option", { name: /user01/i }).click();
  await filterWorkspace.getByRole("button", { name: /^Users/ }).click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  await filterWorkspace.getByRole("button", { name: /^MCPs/ }).click();
  const mcpAssociations = page.locator(".multi-filter-menu");
  if (
    (await mcpAssociations.locator(".association-possible").count()) === 0 ||
    (await mcpAssociations.locator(".association-excluded").count()) === 0
  ) {
    throw new Error("Associative MCP states did not update for user selection");
  }
  const selectExcludedAction = mcpAssociations.getByRole("button", {
    name: /Select excluded/,
  });
  const excludedBeforeAction = Number(
    await selectExcludedAction.locator("span").textContent(),
  );
  const callsBeforeExcludedPreview = await page
    .locator(".kpi-card .kpi-value")
    .first()
    .textContent();
  await selectExcludedAction.click();
  const excludedToolbar = mcpAssociations.getByRole("toolbar", {
    name: "Pending selections",
  });
  await excludedToolbar.waitFor();
  const excludedPendingText =
    (await excludedToolbar.locator(":scope > span").textContent()) ?? "";
  if (!excludedPendingText.startsWith(`${excludedBeforeAction} pending`)) {
    throw new Error(
      `Select excluded drafted the wrong count: ${excludedPendingText}`,
    );
  }
  if (
    (await page.locator(".kpi-card .kpi-value").first().textContent()) !==
    callsBeforeExcludedPreview
  ) {
    throw new Error("Pending selector values changed dashboard totals");
  }
  await page.keyboard.press("Escape");
  if ((await page.locator(".selection-bar .scope-chip.server").count()) !== 0) {
    throw new Error("Cancel did not restore MCP selections");
  }
  await filterWorkspace.getByRole("button", { name: /^MCPs/ }).click();
  const selectPossibleAction = mcpAssociations.getByRole("button", {
    name: /Select possible/,
  });
  const possibleBeforeAction = Number(
    await selectPossibleAction.locator("span").textContent(),
  );
  await selectPossibleAction.click();
  await mcpAssociations
    .getByRole("button", { name: "Apply pending selections" })
    .click();
  const possibleSelectedCount = Number(
    await filterWorkspace
      .getByRole("button", { name: /^MCPs/ })
      .locator("strong")
      .textContent(),
  );
  if (possibleSelectedCount !== possibleBeforeAction) {
    throw new Error("Select possible did not apply all possible MCPs");
  }
  if (
    (await page.locator(".selection-bar .scope-chip.server").count()) !==
    Math.min(4, possibleBeforeAction)
  ) {
    throw new Error("Scope bar did not summarize bulk MCP selections");
  }
  if (possibleBeforeAction > 4) {
    await page
      .getByRole("button", {
        name: `Open filters to review ${possibleBeforeAction - 4} more MCPs`,
      })
      .waitFor();
  }
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear selections" })
    .click();
  await filterWorkspace.getByRole("button", { name: /^Users/ }).click();
  await userFilter.getByRole("option", { name: /user01/i }).click();
  await filterWorkspace.getByRole("button", { name: /^Users/ }).click();
  await filterWorkspace.getByRole("button", { name: /^MCPs/ }).click();
  await mcpAssociations.getByRole("button", { name: "Hide excluded" }).click();
  if ((await mcpAssociations.locator(".association-excluded").count()) !== 0) {
    throw new Error("Associated-only filter view still shows excluded values");
  }
  await mcpAssociations.getByRole("button", { name: "Show excluded" }).click();
  await filterWorkspace.getByRole("button", { name: /^MCPs/ }).click();
  await filterWorkspace.getByRole("button", { name: /^Users/ }).click();
  await userSearch.fill("user02");
  await userFilter.getByRole("option", { name: /user02/i }).click();
  await filterWorkspace.getByRole("button", { name: /^Users/ }).click();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: /Remove user filter/i })
    .first()
    .waitFor();
  await page
    .locator(".preset-group")
    .getByRole("button", { name: "7D" })
    .click();
  await page.locator(".loading-layer").waitFor({ state: "hidden" });
  if (
    (await page
      .locator(".selection-bar")
      .getByRole("button", { name: /Remove user filter/i })
      .count()) !== 2
  ) {
    throw new Error("Date Apply cleared persistent user selections");
  }
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear selections" })
    .click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });

  await modeNav.getByRole("button", { name: "Analysis", exact: true }).click();
  await page.locator(".network-panel").waitFor();
  await page.getByRole("button", { name: "Relationship table" }).click();
  await page.locator(".network-list").waitFor();
  await page.getByRole("button", { name: "Flow map", exact: true }).click();
  const sankeyCanvas = page.locator(".sankey-canvas");
  await sankeyCanvas.scrollIntoViewIfNeeded();
  const sankeyBox = await sankeyCanvas.boundingBox();
  if (!sankeyBox) throw new Error("Sankey canvas is unavailable");
  const sankeyRoot = page.locator(".sankey-canvas > svg > g");
  const transformBeforeWheel =
    (await sankeyRoot.getAttribute("transform")) ?? "";
  const scrollBeforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.move(
    sankeyBox.x + sankeyBox.width / 2,
    sankeyBox.y + sankeyBox.height / 2,
  );
  await page.mouse.wheel(0, 420);
  await page.waitForFunction(
    (previousScroll) => window.scrollY > previousScroll,
    scrollBeforeWheel,
  );
  const transformAfterWheel =
    (await sankeyRoot.getAttribute("transform")) ?? "";
  const scrollAfterWheel = await page.evaluate(() => window.scrollY);
  if (
    transformAfterWheel !== transformBeforeWheel ||
    scrollAfterWheel <= scrollBeforeWheel
  ) {
    throw new Error(
      `Sankey captured page scrolling: ${JSON.stringify({
        transformBeforeWheel,
        transformAfterWheel,
        scrollBeforeWheel,
        scrollAfterWheel,
      })}`,
    );
  }
  if ((await sankeyCanvas.locator("title").count()) !== 0) {
    throw new Error("Sankey still uses flashing native SVG tooltips");
  }
  const serverNodes = page.locator(".sankey-node.server:not(.other) rect");
  for (
    let index = 0;
    index < Math.min(6, await serverNodes.count());
    index += 1
  ) {
    await serverNodes.nth(index).hover();
    await page.locator(".network-hover-readout").waitFor();
  }
  if ((await page.locator(".network-hover-readout").count()) !== 1) {
    throw new Error("Sankey hover readout is unstable");
  }
  const firstServerNode = serverNodes.nth(0);
  const secondServerNode = serverNodes.nth(1);
  const callsBeforeSankeyDraft = await page
    .locator(".kpi-card .kpi-value")
    .first()
    .textContent();
  await page
    .locator(".network-toolbar")
    .getByRole("button", { name: /^Select/ })
    .click();
  const networkSelectionActions = page
    .locator(".network-toolbar")
    .getByRole("dialog", { name: "Association selection actions" });
  await networkSelectionActions
    .getByRole("button", { name: /Select possible/ })
    .click();
  if (
    (await page.locator(".scope-chip.server").count()) !== 0 ||
    (await page.locator(".kpi-card .kpi-value").first().textContent()) !==
      callsBeforeSankeyDraft
  ) {
    throw new Error("Sankey bulk action filtered before confirmation");
  }
  await page.keyboard.press("Escape");
  await firstServerNode.click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  if ((await firstServerNode.getAttribute("aria-pressed")) !== "true") {
    throw new Error("Sankey node did not show its selected state");
  }
  await secondServerNode.click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  if (
    (await page.locator(".scope-chip.server").count()) !== 0 ||
    (await firstServerNode.getAttribute("aria-pressed")) !== "true"
  ) {
    throw new Error("Sankey did not preserve pending MCP selections");
  }
  if (
    (await page.locator(".kpi-card .kpi-value").first().textContent()) !==
    callsBeforeSankeyDraft
  ) {
    throw new Error("Pending Sankey selections changed dashboard totals");
  }
  await page.screenshot({
    path: "artifacts/mcp-dashboard-selections.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page
    .getByRole("toolbar", { name: "Pending selections" })
    .waitFor({ state: "hidden" });
  if ((await page.locator(".scope-chip.server").count()) !== 0) {
    throw new Error("Escape did not cancel Sankey selections");
  }
  await page.getByRole("button", { name: "Flow map", exact: true }).click();
  const refreshedServerNodes = page.locator(
    ".sankey-node.server:not(.other) rect",
  );
  await refreshedServerNodes.first().waitFor();
  await refreshedServerNodes.nth(0).click();
  await refreshedServerNodes.nth(1).click();
  await page.getByRole("button", { name: "Apply pending selections" }).click();
  if ((await page.locator(".scope-chip.server").count()) !== 2) {
    throw new Error("Sankey apply did not commit multiple MCP selections");
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".sankey-node.server:not(.other)").length === 2,
  );
  const sankeyThickness = await page.evaluate(() => ({
    maxNodeHeight: Math.max(
      ...[
        ...document.querySelectorAll<SVGRectElement>(".sankey-node rect"),
      ].map((rect) => Number(rect.getAttribute("height") ?? 0)),
    ),
    maxLinkWidth: Math.max(
      ...[...document.querySelectorAll<SVGPathElement>(".sankey-link")].map(
        (link) => Number(link.getAttribute("stroke-width") ?? 0),
      ),
    ),
  }));
  if (
    sankeyThickness.maxNodeHeight > SANKEY_MAX_NODE_HEIGHT + 0.1 ||
    sankeyThickness.maxLinkWidth > SANKEY_MAX_LINK_WIDTH + 0.1
  ) {
    throw new Error(
      `Sankey thickness caps failed: ${JSON.stringify(sankeyThickness)}`,
    );
  }
  await page.locator(".network-panel").screenshot({
    path: "artifacts/mcp-dashboard-sankey-drill.png",
  });
  if (
    (await page
      .locator('.sankey-node.server rect[aria-pressed="true"]')
      .count()) !== 2
  ) {
    throw new Error("Sankey did not preserve committed MCP selections");
  }
  await page.waitForFunction(
    (previous) =>
      document.querySelector(".kpi-card .kpi-value")?.textContent !== previous,
    callsBeforeSankeyDraft,
  );
  await firstServerNode.click();
  await secondServerNode.click();
  await page.getByRole("button", { name: "Apply pending selections" }).click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  if ((await page.locator(".scope-chip.server").count()) !== 0) {
    throw new Error("Sankey click did not toggle selected MCPs off");
  }
  const otherMcpNode = page.locator(".sankey-node.other", {
    hasText: "Other MCPs",
  });
  const otherUserNode = page.locator(".sankey-node.other", {
    hasText: "Other users",
  });
  await otherMcpNode.locator("rect").click();
  await page.getByRole("heading", { name: "Other MCPs" }).waitFor();
  await page.getByRole("button", { name: "Close other entities" }).click();
  await otherUserNode.locator("rect").click();
  await page.getByRole("heading", { name: "Other users" }).waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Select/ })
    .waitFor();
  const overflowUsers = page
    .getByRole("dialog")
    .locator(".kpi-detail-row.interactive");
  await overflowUsers.nth(0).click();
  await overflowUsers.nth(1).click();
  await page.locator(".filtering-indicator").waitFor({ state: "hidden" });
  if ((await page.locator(".selection-bar .scope-chip.user").count()) !== 0) {
    throw new Error("Overflow chart committed selections before confirmation");
  }
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Apply pending selections" })
    .click();
  if ((await page.locator(".selection-bar .scope-chip.user").count()) !== 2) {
    throw new Error("Overflow apply did not commit user selections");
  }
  await overflowUsers.nth(0).click();
  await overflowUsers.nth(1).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Apply pending selections" })
    .click();
  await page.getByRole("button", { name: "Close other entities" }).click();
  for (let index = 0; index < 5; index += 1) {
    const currentTransform = (await sankeyRoot.getAttribute("transform")) ?? "";
    const currentScale = Number(
      currentTransform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1,
    );
    if (currentScale >= 1.79) break;
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.waitForFunction(
      (targetScale) => {
        const transform =
          document
            .querySelector(".sankey-canvas > svg > g")
            ?.getAttribute("transform") ?? "";
        return (
          Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1) >=
          targetScale - 0.01
        );
      },
      Math.min(1.8, currentScale * 1.25),
    );
  }
  await page.waitForFunction(() => {
    const transform =
      document
        .querySelector(".sankey-canvas > svg > g")
        ?.getAttribute("transform") ?? "";
    return Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1) >= 1.79;
  });
  const maxZoomTransform = (await sankeyRoot.getAttribute("transform")) ?? "";
  const maxZoom = Number(maxZoomTransform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
  if (maxZoom < 1.79 || maxZoom > 1.81) {
    throw new Error(`Sankey maximum zoom is incorrect: ${maxZoom}`);
  }
  await page.getByRole("button", { name: "Reset view" }).click();
  if (await filterWorkspace.isVisible()) {
    await page.getByRole("button", { name: /^Filters/ }).click();
  }
  await page
    .getByText("Pivot workspace", { exact: true })
    .scrollIntoViewIfNeeded();
  const availableFieldChip = page
    .locator(".field-library .dimension-chip")
    .first();
  await availableFieldChip.click();
  const fieldActionMenu = page.locator(".dimension-chip-menu");
  if (
    (await fieldActionMenu.getByRole("button").allTextContents()).join("|") !==
    "Add to rows|Add to columns"
  ) {
    throw new Error("Compact pivot field menu is missing Rows/Columns actions");
  }
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await page.locator(".selection-bar.is-stuck").waitFor();
  const stickyScopeBox = await page.locator(".selection-bar").boundingBox();
  if (
    !stickyScopeBox ||
    stickyScopeBox.y < -1 ||
    stickyScopeBox.y > 2 ||
    !(await page
      .locator(".selection-bar")
      .evaluate((element) => element.classList.contains("is-stuck")))
  ) {
    throw new Error(
      `Selection bar did not remain sticky while scrolling: ${JSON.stringify(stickyScopeBox)}`,
    );
  }
  const pivotDimensions = page.locator(
    ".pivot-table tbody .pivot-dimension-select",
  );
  await pivotDimensions.nth(0).click();
  await pivotDimensions.nth(1).click();
  if ((await page.locator(".selection-bar .scope-chip.server").count()) !== 0) {
    throw new Error("Pivot committed dimension selections before confirmation");
  }
  const pivotApplyBox = await page
    .locator(".pivot-heading-actions")
    .getByRole("button", { name: "Apply pending selections" })
    .boundingBox();
  if (
    !pivotApplyBox ||
    pivotApplyBox.width < 100 ||
    pivotApplyBox.height < 30
  ) {
    throw new Error(
      `Pivot apply action is not prominent enough: ${JSON.stringify(pivotApplyBox)}`,
    );
  }
  await page
    .locator("#pivot-workspace")
    .getByRole("button", { name: "Apply pending selections" })
    .click();
  if ((await page.locator(".selection-bar .scope-chip.server").count()) !== 2) {
    throw new Error("Pivot did not apply multiple dimension selections");
  }
  const pivotHeaderFilter = page
    .locator(".pivot-table thead")
    .getByRole("button", { name: "Filter MCP server" })
    .first();
  if (
    (await page
      .locator(
        ".pivot-table thead .multi-filter-possible, .pivot-table thead .association-state-bar",
      )
      .count()) !== 0
  ) {
    throw new Error(
      "Pivot compact filters rendered full-size selector metrics",
    );
  }
  await pivotHeaderFilter.click();
  const pivotHeaderMenuVisible = await page
    .locator(".pivot-table .multi-filter-menu")
    .evaluate((menu) => {
      const box = menu.getBoundingClientRect();
      const top = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + 20,
      );
      return (
        box.top >= 0 &&
        box.bottom <= window.innerHeight &&
        Boolean(top && menu.contains(top))
      );
    });
  if (!pivotHeaderMenuVisible) {
    throw new Error("Pivot header filter menu is clipped or obscured");
  }
  await page.keyboard.press("Escape");
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear selections" })
    .click();
  if ((await page.locator(".selection-bar .scope-chip.server").count()) !== 0) {
    throw new Error("Pivot did not remove confirmed selections");
  }
  if (
    (await modeNav
      .getByRole("button", { name: "Analysis", exact: true })
      .getAttribute("aria-pressed")) !== "true"
  ) {
    throw new Error("Analysis task mode lost its active state");
  }
  if (await filterWorkspace.isVisible()) {
    await page
      .locator(".selection-bar")
      .getByRole("button", { name: /^Filters/ })
      .click();
  }
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: /^Filters/ })
    .click();
  const stickyWorkspace = page.locator(".sticky-filter-workspace");
  await stickyWorkspace.waitFor();
  const expandedScopeLayout = await stickyWorkspace.evaluate((workspace) => {
    const selectionBar = workspace.closest<HTMLElement>(".selection-bar");
    return {
      position: getComputedStyle(workspace).position,
      workspaceHeight: workspace.getBoundingClientRect().height,
      selectionBarHeight: selectionBar?.getBoundingClientRect().height ?? 0,
    };
  });
  if (
    expandedScopeLayout.position === "absolute" ||
    expandedScopeLayout.selectionBarHeight <
      stickyScopeBox.height + expandedScopeLayout.workspaceHeight * 0.8
  ) {
    throw new Error(
      `Sticky filters did not expand within the scope bar: ${JSON.stringify(expandedScopeLayout)}`,
    );
  }
  const stickyMcpTrigger = stickyWorkspace.getByRole("button", {
    name: /^MCPs/,
  });
  await stickyMcpTrigger.click();
  await stickyWorkspace
    .locator(".multi-filter-menu")
    .getByRole("option")
    .first()
    .click();
  await stickyMcpTrigger.click();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: /Remove MCP filter/i })
    .waitFor();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: /Remove MCP filter/i })
    .click();
  await page.getByRole("button", { name: "Close sticky filters" }).click();
  await page
    .locator(".pivot-table thead .hierarchy-column")
    .filter({ hasText: "MCP server › User" })
    .waitFor();
  const pivotSort = page.locator(".pivot-sort-controls select");
  await pivotSort.selectOption("__label__");
  const sortedLabels = await page
    .locator(
      ".pivot-tree-row.depth-0 .pivot-dimension-select > span:first-child",
    )
    .allTextContents();
  const expectedLabels = [...sortedLabels].sort((a, b) => a.localeCompare(b));
  if (sortedLabels.join("\u0000") !== expectedLabels.join("\u0000")) {
    throw new Error("Pivot row-label sorting is incorrect");
  }
  await pivotSort.selectOption("__total__");
  if (
    (await page
      .locator(".pivot-table thead .pivot-total-column")
      .getAttribute("aria-sort")) !== "descending"
  ) {
    throw new Error("Pivot total sorting did not apply");
  }
  await page.getByLabel("Show zeros").check();
  await page.getByLabel("Show zeros").uncheck();
  await page.locator(".tree-caret-button").first().click();
  if ((await page.locator(".pivot-tree-row.depth-1").count()) === 0) {
    throw new Error("Compact pivot hierarchy did not reveal nested users");
  }
  await page.getByRole("button", { name: "Collapse all" }).click();
  if ((await page.locator(".pivot-tree-row.depth-1").count()) !== 0) {
    throw new Error("Compact pivot hierarchy did not collapse");
  }
  await page.getByLabel("Row layout").selectOption("tabular");
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        ".pivot-table thead .row-dimension:not(.hierarchy-column)",
      ).length >= 2,
  );
  const rowHeaders = await page
    .locator(".pivot-table thead .row-dimension")
    .allTextContents();
  if (
    !rowHeaders.some((header) => header.includes("MCP server")) ||
    !rowHeaders.some((header) => header.includes("User"))
  ) {
    throw new Error("Tabular pivot dimensions are not separate columns");
  }
  await page.getByLabel("Row layout").selectOption("compact");
  await page.getByRole("button", { name: "Hide fields", exact: true }).click();
  await page.locator("#pivot-builder").waitFor({ state: "detached" });
  await page.locator(".pivot-table-wrap").waitFor();
  await page.getByRole("button", { name: "Show fields", exact: true }).click();
  await page.locator("#pivot-builder").waitFor();
  const renderSize = await page.evaluate(() => ({
    elements: document.querySelectorAll("*").length,
    pivotCells: document.querySelectorAll(".pivot-table th, .pivot-table td")
      .length,
  }));
  if (renderSize.elements > 10_000 || renderSize.pivotCells > 2_000) {
    throw new Error(
      `Dashboard rendered an unsafe DOM size: ${JSON.stringify(renderSize)}`,
    );
  }

  await modeNav.getByRole("button", { name: "Reporting", exact: true }).click();
  await page
    .getByText("User–MCP report", { exact: true })
    .scrollIntoViewIfNeeded();
  const reportUserSelections = page.locator(
    '.inventory-table tbody th[data-label="User"] > .inventory-dimension-select',
  );
  const reportUserLabels = await reportUserSelections.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label") ?? ""),
  );
  const firstUserIndex = 0;
  const secondUserIndex = reportUserLabels.findIndex(
    (label) => label && label !== reportUserLabels[firstUserIndex],
  );
  if (secondUserIndex < 0) {
    throw new Error("Straight table did not expose two selectable users");
  }
  await reportUserSelections.nth(firstUserIndex).click();
  await reportUserSelections.nth(secondUserIndex).click();
  await page
    .locator(".inventory-heading")
    .getByRole("button", { name: "Cancel pending selections" })
    .click();
  if (
    (await reportUserSelections
      .nth(firstUserIndex)
      .getAttribute("aria-pressed")) !== "false"
  ) {
    throw new Error("Straight table cancel did not restore user selections");
  }
  await reportUserSelections.nth(firstUserIndex).click();
  await reportUserSelections.nth(secondUserIndex).click();
  await page
    .locator(".user-mcp-inventory")
    .getByRole("button", { name: "Apply pending selections" })
    .click();
  if ((await page.locator(".selection-bar .scope-chip.user").count()) !== 2) {
    throw new Error("Straight table did not apply multiple user selections");
  }
  for (const label of [
    "Filter User",
    "Filter Groups",
    "Filter MCP",
    "Filter First observed",
    "Filter Last used",
    "Filter Tools",
  ]) {
    await page
      .locator(".inventory-table thead")
      .getByRole("button", { name: label })
      .waitFor();
  }
  if (
    (await page
      .locator(
        ".inventory-table thead .multi-filter-possible, .inventory-table thead .association-state-bar",
      )
      .count()) !== 0
  ) {
    throw new Error(
      "Straight-table compact filters rendered full-size selector metrics",
    );
  }
  await page
    .locator(".inventory-table thead")
    .getByRole("button", { name: "Filter User" })
    .click();
  const reportHeaderMenuVisible = await page
    .locator(".inventory-table .multi-filter-menu")
    .evaluate((menu) => {
      const box = menu.getBoundingClientRect();
      const top = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + 20,
      );
      return (
        box.left >= 0 &&
        box.right <= window.innerWidth &&
        box.top >= 0 &&
        box.bottom <= window.innerHeight &&
        Boolean(top && menu.contains(top))
      );
    });
  if (!reportHeaderMenuVisible) {
    throw new Error("Straight-table header filter menu is clipped or obscured");
  }
  await page.keyboard.press("Escape");
  const reportMcpSelection = page
    .locator(
      '.inventory-table tbody td[data-label="MCP"] .inventory-dimension-select',
    )
    .first();
  await reportMcpSelection.click();
  await page
    .locator(".inventory-heading")
    .getByRole("button", { name: "Apply pending selections" })
    .click();
  if ((await page.locator(".selection-bar .scope-chip.server").count()) !== 1) {
    throw new Error("Straight table MCP dimension selection did not apply");
  }
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear selections" })
    .click();

  await exportTrigger.click();
  await exportCenter
    .getByRole("button", { name: /Raw activity records.*CSV.*TSV.*XLSX/i })
    .click();
  const activityFormatDialog = page.getByRole("dialog", {
    name: "Raw activity records",
  });
  await activityFormatDialog
    .getByRole("radio", { name: /CSV/i })
    .check({ force: true });
  const csvDownload = page.waitForEvent("download");
  await activityFormatDialog
    .getByRole("button", { name: "Download CSV" })
    .click();
  if (!(await csvDownload).suggestedFilename().endsWith(".csv")) {
    throw new Error("Filtered CSV export did not download");
  }

  await exportTrigger.click();
  const pivotExportOption = exportCenter.getByRole("button", {
    name: /Current pivot table.*CSV.*TSV.*XLSX/i,
  });
  await pivotExportOption.waitFor();
  if (await pivotExportOption.isDisabled()) {
    throw new Error("Configured pivot is unavailable in the export center");
  }
  await pivotExportOption.click();
  const pivotFormatDialog = page.getByRole("dialog", {
    name: "Current pivot table",
  });
  if ((await pivotFormatDialog.getByRole("radio").count()) !== 3) {
    throw new Error("Pivot export does not offer CSV, TSV, and XLSX");
  }
  const xlsxDownload = page.waitForEvent("download");
  await pivotFormatDialog
    .getByRole("button", { name: "Download XLSX" })
    .click();
  const downloadedXlsx = await xlsxDownload;
  const xlsxPath = await downloadedXlsx.path();
  if (!downloadedXlsx.suggestedFilename().endsWith(".xlsx") || !xlsxPath) {
    throw new Error("Pivot XLSX export is not a valid workbook download");
  }
  const workbook = await readXlsxFile(xlsxPath);
  const manifestSheet = workbook.find((sheet) => sheet.sheet === "Manifest");
  const pivotSheet = workbook.find((sheet) => sheet.sheet === "Pivot");
  if (
    !manifestSheet ||
    !pivotSheet ||
    manifestSheet.data[0]?.[0] !== "Dashboard export manifest" ||
    !manifestSheet.data.some(
      (row) =>
        row[0] === "exported_grain" &&
        typeof row[1] === "string" &&
        row[1].length > 0,
    ) ||
    !manifestSheet.data.some(
      (row) => row[0] === "exported_row_count" && Number(row[1]) > 0,
    ) ||
    !pivotSheet.data[0]?.includes("Total") ||
    pivotSheet.data.length < 2
  ) {
    throw new Error(
      `Pivot XLSX export is missing expected sheets or data: ${JSON.stringify(
        workbook.map((sheet) => ({
          sheet: sheet.sheet,
          rows: sheet.data.slice(0, 3),
        })),
      )}`,
    );
  }

  await exportTrigger.click();
  const snapshotDownload = page.waitForEvent("download");
  await exportCenter
    .getByRole("button", { name: /Interactive dashboard snapshot.*HTML/i })
    .click();
  const downloadedSnapshot = await snapshotDownload;
  const snapshotPath = await downloadedSnapshot.path();
  if (!snapshotPath) throw new Error("Snapshot download path unavailable");
  const snapshotHtml = await readFile(snapshotPath, "utf8");
  if (
    !snapshotHtml.includes('id="mcp-snapshot"') ||
    /Authorization:\s*Basic|key_[A-Za-z0-9_-]{12,}/i.test(
      snapshotHtml.match(
        /<script id="mcp-snapshot" type="application\/json">([\s\S]*?)<\/script>/,
      )?.[1] ?? "",
    )
  ) {
    throw new Error("Interactive snapshot safety validation failed");
  }

  const geometry = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - viewportWidth;
    const outside = [
      ...document.querySelectorAll<HTMLElement>(
        ".topbar, main, footer, .control-deck, .kpi-card, .panel",
      ),
    ]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.left < -2 || box.right > viewportWidth + 2;
      })
      .map((element) => element.className);
    return { overflow, outside };
  });
  if (geometry.overflow > 2 || geometry.outside.length > 0) {
    throw new Error(`Geometry check failed: ${JSON.stringify(geometry)}`);
  }

  await exportTrigger.click();
  await exportCenter.screenshot({
    path: "artifacts/mcp-dashboard-export-center.png",
  });
  await exportCenter
    .getByRole("button", { name: "Close export center" })
    .click();
  await page.screenshot({
    path: "artifacts/mcp-dashboard-smoke.png",
    fullPage: true,
  });
  console.log(
    `Browser smoke test passed: dashboard, drawer, drag/drop, exports, loading modal, ${renderSize.elements} DOM elements, ${renderSize.pivotCells} pivot cells`,
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
