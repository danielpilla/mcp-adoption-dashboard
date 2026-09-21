# Dashboard usage

## Navigation and scope

The dashboard is organized into Dashboard, Analysis, and Reporting views. The
scope bar preserves filters while moving between views and provides the single
**Clear selections** action.

The initial range is 90 days. Choose a preset or valid custom UTC range to
reload data. **Refresh** bypasses the 12-hour server cache while preserving
the current date drill-down and associative selections. Refreshes for the same
range are limited to once every 10 seconds.

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
