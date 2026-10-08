# Dashboard usage

## Startup range

Before the first load, the dashboard asks for a starting range: a 7, 30, 90,
180, or 365-day preset, or a custom UTC start and end date. Custom ranges are
inclusive, cannot end in the future, and are limited to 366 days; an invalid
range shows why and cannot be loaded. Each preset shows how much of it the
per-day cache already holds: **Cached**, a partial meter, or the relative
first-load effort. Longer ranges take longer the first time; cached days load
without another request.

The largest fully cached preset is pre-selected. When nothing is cached, the
last `DEFAULT_RANGE_DAYS` days (default 90) are pre-selected; a value that is
not a preset stays a rolling range of that length.

The chosen range is remembered on the server in `startup-range.json` inside
`MCP_CACHE_DIR`, and in the browser when the server cannot store it. On the
next start, a remembered range that already has cached days loads at once. If
none of its days are cached, the picker opens with that range selected and
marked **Last used**. **Change range** on the loading screen stops the current
load and reopens the picker. Deleting `MCP_CACHE_DIR` forgets the remembered
range; changing the API key does not.

## Loading progress

The loading screen reports, for MCP activity:

- days loaded out of the range, split into days from the cache and days
  fetched from Cursor
- the 30-day window being fetched, its page, and how many other windows are
  running in parallel
- activity rows loaded so far
- elapsed time and an estimate of the time remaining, from the rate observed
  so far
- a retry notice with a countdown, the reason, and the attempt number while
  Cursor asks for a pause or a request is retried
- a slow notice when no new page has arrived for 15 seconds, and a quiet
  notice when the local server has not answered for 8 seconds

The same progress appears in a non-blocking notice above the dashboard while a
range change or **Refresh** reloads data in the background.

## Navigation and scope

The dashboard is organized into Dashboard, Analysis, and Reporting views. The
scope bar preserves filters while moving between views and provides the single
**Clear selections** action.

Choose a preset or valid custom UTC range in the header to reload data.
**Refresh** bypasses the 12-hour server cache while preserving the current date
drill-down and associative selections. Refreshes for the same range are limited
to once every 10 seconds.

The loading screen also shows the background directory load. The dashboard
opens as soon as activity is loaded; while the directory is still loading, a
notice shows its progress and names, roles, and group filters appear
automatically when it finishes.

If a cap or timeout is reached, the dashboard shows the data loaded so far,
newest days first, with a notice that names the setting to raise. When some
days are complete, **Show complete days from** narrows the view to them.

Search users, email addresses, MCP labels, and tools with `Cmd/Ctrl+K`. Filters
support users, MCPs, MCP type (internal or external), tools, directory groups,
and multiple calendar grains. Values within one field are combined with OR;
fields are combined with AND. Excluded values remain visible so missing
relationships can be inspected. On narrow screens, open **Filters** in the
scope bar to access search and the complete filter set.

Chart, pivot, and report selections are provisional. Select one or more values,
then press Enter or use the checkmark to apply. Press Escape or use the cancel
action to discard the draft. Locked selections remain active when the global
clear action is used.

## Analysis

The daily chart can display calls, distinct users, observed MCP labels, or
distinct MCP–tool pairs. Select points or brush a range to draft date filters.

The relationship view shows call concentration between users and MCP labels.
Select nodes to filter the dashboard, use the accessible list as an
alternative, and open the “Other” drawers to inspect the long tail.

The pivot workspace supports draggable row and column fields, compact or
tabular row layouts, sorting, expansion, and call or unique-user measures.

## Reporting and exports

The user–MCP inventory follows the full dashboard scope. Each row represents an
observed user/MCP relationship in the selected evidence window; it does not
prove that an MCP remains configured or authenticated.

**Export current scope** provides:

- Raw activity records
- Aggregated user–MCP records
- The configured pivot table
- Deduplicated email addresses
- An interactive HTML snapshot

Tabular exports support CSV, TSV, and XLSX. XLSX files contain a Manifest sheet
and an export-specific data sheet. CSV and TSV files remain rectangular for
direct import into data tools; provenance is included in XLSX and HTML snapshot
exports. Interactive HTML snapshots are available from the production build
(`npm run build && npm start`) and Docker, not from `npm run dev`. Exports
include all matching rows, not only the visible page.

The user–MCP schema includes `display_name`, `email`, `role`,
`directory_groups`, `mcp_server`, `first_observed`,
`last_observed`, `active_days`, `total_calls`, `distinct_tools`, and `tools`.

Interactive snapshots preserve the exported scope and remain usable without
the server. They exclude the API key and authorization header, but they contain
the filtered employee usage data. Store and share every export as sensitive
data.
