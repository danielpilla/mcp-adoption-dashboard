import { formatNumber, serverUsage } from "../analytics/activity-metrics";
import { McpServerLabel } from "./mcp-server-label";
import { SelectionMark } from "../scope/selection-mark";

type ServerUsage = ReturnType<typeof serverUsage>[number];

export function ServerUsageRow({
  server,
  rank,
  selected,
  onSelect,
}: {
  server: ServerUsage;
  rank: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`kpi-detail-row interactive chart-selectable${selected ? " selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="user-rank">{String(rank).padStart(2, "0")}</span>
      <span className="kpi-detail-main">
        <strong>
          <McpServerLabel server={server.server} />
        </strong>
        <small>
          {server.users} users · {server.tools} tools
        </small>
      </span>
      <strong>{formatNumber(server.usage)}</strong>
      <SelectionMark selected={selected} />
    </button>
  );
}
