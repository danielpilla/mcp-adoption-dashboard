import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import {
  sankey,
  sankeyLinkHorizontal,
  type SankeyGraph,
  type SankeyNode,
} from "d3-sankey";
import type { McpRecord } from "../../contracts/mcp-response";
import { serverUsage, userUsage } from "../analytics/activity-metrics";
import { McpServerLabel } from "./mcp-server-label";
import {
  SelectionToolbar,
  type SelectionActionField,
} from "../scope/selection-toolbar";
import type { SelectionField } from "../scope/selection-model";

interface NodeData {
  id: string;
  label: string;
  kind: "server" | "user";
  usage: number;
  email?: string;
  isOther?: boolean;
}

interface LinkData {
  source: string;
  target: string;
  value: number;
  usage: number;
}

type LayoutNode = SankeyNode<NodeData, LinkData>;

const WIDTH = 1_200;
const HEIGHT = 510;
const SANKEY_TOP_GUTTER = 42;
export const SANKEY_MAX_NODE_HEIGHT = 72;
export const SANKEY_MAX_LINK_WIDTH = 28;
export const SANKEY_SERVER_LIMIT = 10;
export const SANKEY_USER_LIMIT = 36;
const RELATIONSHIP_PAGE_SIZE = 50;
const relationshipNodeId = (kind: "server" | "user", value: string) =>
  JSON.stringify([kind, value]);
const OTHER_SERVER_ID = JSON.stringify(["other", "server"]);
const OTHER_USER_ID = JSON.stringify(["other", "user"]);

function capSankeyThickness(layout: SankeyGraph<NodeData, LinkData>): void {
  const maxLinkWidth = layout.links.reduce(
    (maximum, link) => Math.max(maximum, link.width ?? 0),
    0,
  );
  let maxNodeFlowWidth = 0;
  for (const node of layout.nodes) {
    const outgoing = node.sourceLinks ?? [];
    const incoming = node.targetLinks ?? [];
    const outgoingWidth = outgoing.reduce(
      (sum, link) => sum + (link.width ?? 0),
      0,
    );
    const incomingWidth = incoming.reduce(
      (sum, link) => sum + (link.width ?? 0),
      0,
    );
    maxNodeFlowWidth = Math.max(maxNodeFlowWidth, outgoingWidth, incomingWidth);
  }

  const scale = Math.min(
    1,
    maxLinkWidth > 0 ? SANKEY_MAX_LINK_WIDTH / maxLinkWidth : 1,
    maxNodeFlowWidth > 0 ? SANKEY_MAX_NODE_HEIGHT / maxNodeFlowWidth : 1,
  );
  for (const link of layout.links) {
    link.width = (link.width ?? 0) * scale;
  }

  for (const node of layout.nodes) {
    const center = ((node.y0 ?? 0) + (node.y1 ?? 0)) / 2;
    const outgoing = node.sourceLinks ?? [];
    const incoming = node.targetLinks ?? [];
    const outgoingWidth = outgoing.reduce(
      (sum, link) => sum + (link.width ?? 0),
      0,
    );
    const incomingWidth = incoming.reduce(
      (sum, link) => sum + (link.width ?? 0),
      0,
    );
    const nodeHeight = Math.max(
      2,
      Math.min(SANKEY_MAX_NODE_HEIGHT, Math.max(outgoingWidth, incomingWidth)),
    );
    node.y0 = center - nodeHeight / 2;
    node.y1 = center + nodeHeight / 2;

    let sourceY = center - outgoingWidth / 2;
    for (const link of outgoing) {
      link.y0 = sourceY + (link.width ?? 0) / 2;
      sourceY += link.width ?? 0;
    }
    let targetY = center - incomingWidth / 2;
    for (const link of incoming) {
      link.y1 = targetY + (link.width ?? 0) / 2;
      targetY += link.width ?? 0;
    }
  }
}

export const NetworkGraph = memo(function NetworkGraph({
  records,
  selectedServers,
  selectedUsers,
  onToggleServer,
  onToggleUser,
  selectionActive,
  pendingChangeCount,
  onApplySelection,
  onCancelSelection,
  selectionFields,
  onSelectValues,
  onSelectOther,
}: {
  records: McpRecord[];
  selectedServers: string[];
  selectedUsers: string[];
  onToggleServer: (server: string) => void;
  onToggleUser: (email: string) => void;
  selectionActive: boolean;
  pendingChangeCount: number;
  onApplySelection: () => void;
  onCancelSelection: () => void;
  selectionFields: SelectionActionField[];
  onSelectValues: (field: SelectionField, values: string[]) => void;
  onSelectOther: (kind: "servers" | "users") => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const nodeRefs = useRef<Array<SVGRectElement | null>>([]);
  // Associative evaluation can return a new array containing the same records;
  // preserve its identity to avoid an unnecessary D3 layout and zoom reset.
  const stableRecordsRef = useRef(records);
  if (
    stableRecordsRef.current.length !== records.length ||
    stableRecordsRef.current.some((record, index) => record !== records[index])
  ) {
    stableRecordsRef.current = records;
  }
  const stableRecords = stableRecordsRef.current;
  const [mode, setMode] = useState<"sankey" | "list">("sankey");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeNodeIndex, setActiveNodeIndex] = useState(0);
  const [listPage, setListPage] = useState(0);
  useEffect(() => {
    const compactView = window.matchMedia("(max-width: 820px)");
    if (compactView.matches) setMode("list");
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMode("list");
    };
    compactView.addEventListener("change", onChange);
    return () => compactView.removeEventListener("change", onChange);
  }, []);

  const graph = useMemo(() => {
    const allServers = serverUsage(stableRecords);
    const serverLimit = SANKEY_SERVER_LIMIT;
    const topServers = allServers.slice(0, serverLimit);
    const otherServers = allServers.slice(serverLimit);
    const serverSet = new Set(topServers.map((item) => item.server));
    const allUsers = userUsage(stableRecords);
    const topUsers = allUsers.slice(0, SANKEY_USER_LIMIT);
    const otherUsers = allUsers.slice(SANKEY_USER_LIMIT);
    const userSet = new Set(topUsers.map((item) => item.email));
    const linkTotals = new Map<
      string,
      { source: string; target: string; usage: number }
    >();
    const nodeTotals = new Map<string, number>();
    for (const record of stableRecords) {
      const source = serverSet.has(record.server)
        ? relationshipNodeId("server", record.server)
        : OTHER_SERVER_ID;
      const target = userSet.has(record.email)
        ? relationshipNodeId("user", record.email)
        : OTHER_USER_ID;
      const key = JSON.stringify([source, target]);
      const link = linkTotals.get(key) ?? { source, target, usage: 0 };
      link.usage += record.usage;
      linkTotals.set(key, link);
      nodeTotals.set(source, (nodeTotals.get(source) ?? 0) + record.usage);
      nodeTotals.set(target, (nodeTotals.get(target) ?? 0) + record.usage);
    }
    const links: LinkData[] = [...linkTotals.values()].map((link) => ({
      ...link,
      value: link.usage,
    }));
    const nodes: NodeData[] = [
      ...topServers.map((item) => ({
        id: relationshipNodeId("server", item.server),
        label: item.server,
        kind: "server" as const,
        usage:
          nodeTotals.get(relationshipNodeId("server", item.server)) ??
          item.usage,
      })),
      ...(otherServers.length
        ? [
            {
              id: OTHER_SERVER_ID,
              label: `Other MCPs · ${otherServers.length}`,
              kind: "server" as const,
              usage: nodeTotals.get(OTHER_SERVER_ID) ?? 0,
              isOther: true,
            },
          ]
        : []),
      ...topUsers.map((item) => ({
        id: relationshipNodeId("user", item.email),
        label: item.displayName,
        kind: "user" as const,
        usage:
          nodeTotals.get(relationshipNodeId("user", item.email)) ?? item.usage,
        email: item.email,
      })),
      ...(otherUsers.length
        ? [
            {
              id: OTHER_USER_ID,
              label: `Other users · ${otherUsers.length}`,
              kind: "user" as const,
              usage: nodeTotals.get(OTHER_USER_ID) ?? 0,
              isOther: true,
            },
          ]
        : []),
    ];

    if (nodes.length === 0 || links.length === 0) {
      return {
        layout: null,
        topServers,
        otherServers,
        connectedIds: new Map<string, Set<string>>(),
      };
    }

    const layout = sankey<NodeData, LinkData>()
      .nodeId((node) => node.id)
      .nodeWidth(18)
      .nodePadding(9)
      .nodeSort((a, b) => b.usage - a.usage)
      .extent([
        [180, SANKEY_TOP_GUTTER],
        [1_000, HEIGHT - 14],
      ])
      .iterations(48)({
      nodes: nodes.map((node) => ({ ...node })),
      links: links.map((link) => ({ ...link })),
    } as SankeyGraph<NodeData, LinkData>);
    capSankeyThickness(layout);

    const connectedIds = new Map<string, Set<string>>();
    for (const link of layout.links) {
      const source = (link.source as LayoutNode).id;
      const target = (link.target as LayoutNode).id;
      const sourceConnections = connectedIds.get(source) ?? new Set<string>();
      const targetConnections = connectedIds.get(target) ?? new Set<string>();
      sourceConnections.add(target);
      targetConnections.add(source);
      connectedIds.set(source, sourceConnections);
      connectedIds.set(target, targetConnections);
    }

    return { layout, topServers, otherServers, connectedIds };
  }, [stableRecords]);

  useEffect(() => {
    if (!svgRef.current || !rootRef.current || mode !== "sankey") return;
    const svg = svgRef.current;
    const root = d3.select(rootRef.current);
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.7, 1.8])
      .filter(
        (event) => event.type !== "wheel" || event.ctrlKey || event.metaKey,
      )
      .on("zoom", (event) => root.attr("transform", event.transform));
    zoomRef.current = zoom;
    root.attr("transform", null);
    d3.select(svg).call(zoom).on("dblclick.zoom", null);
    return () => {
      d3.select(svg).on(".zoom", null);
      zoomRef.current = null;
    };
  }, [mode, graph.layout]);

  useEffect(() => {
    setListPage(0);
  }, [graph.layout]);

  const zoomBy = (factor: number) => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = d3.select(svgRef.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      svg.call(zoomRef.current.scaleBy, factor);
      return;
    }
    svg.transition().duration(180).call(zoomRef.current.scaleBy, factor);
  };

  const resetZoom = () => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = d3.select(svgRef.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      svg.call(zoomRef.current.transform, d3.zoomIdentity);
      return;
    }
    svg
      .transition()
      .duration(220)
      .call(zoomRef.current.transform, d3.zoomIdentity);
  };

  if (!graph.layout) {
    return <div className="graph-empty">No relationships to map</div>;
  }

  const selectedNodeIds = new Set([
    ...selectedServers.map((server) => relationshipNodeId("server", server)),
    ...selectedUsers.map((user) => relationshipNodeId("user", user)),
  ]);
  const hasSelections = selectedNodeIds.size > 0;
  const isEmphasized = (nodeId: string) => {
    if (hoveredId) {
      return (
        nodeId === hoveredId ||
        Boolean(graph.connectedIds.get(hoveredId)?.has(nodeId))
      );
    }
    if (!hasSelections) return true;
    if (selectedNodeIds.has(nodeId)) return true;
    return [...selectedNodeIds].some((selectedId) =>
      graph.connectedIds.get(selectedId)?.has(nodeId),
    );
  };
  const hoveredNode = hoveredId
    ? graph.layout.nodes.find((node) => node.id === hoveredId)
    : undefined;
  const linkPath = sankeyLinkHorizontal<NodeData, LinkData>();
  const activateNode = (node: LayoutNode) => {
    if (node.isOther) {
      onSelectOther(node.kind === "server" ? "servers" : "users");
    } else if (node.kind === "server") {
      onToggleServer(node.label);
    } else {
      onToggleUser(node.email ?? node.label);
    }
  };
  const relationshipRows = [...graph.layout.links].sort(
    (left, right) => right.usage - left.usage,
  );
  const listPageCount = Math.max(
    1,
    Math.ceil(relationshipRows.length / RELATIONSHIP_PAGE_SIZE),
  );
  const visibleRelationshipRows = relationshipRows.slice(
    listPage * RELATIONSHIP_PAGE_SIZE,
    (listPage + 1) * RELATIONSHIP_PAGE_SIZE,
  );

  return (
    <div className="network-explorer">
      <div className="network-toolbar" aria-label="Relationship view controls">
        <div className="view-toggle">
          <button
            type="button"
            className={mode === "sankey" ? "active" : ""}
            aria-pressed={mode === "sankey"}
            onClick={() => setMode("sankey")}
          >
            Flow map
          </button>
          <button
            type="button"
            className={mode === "list" ? "active" : ""}
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
          >
            Relationship table
          </button>
        </div>
        {mode === "sankey" && (
          <div className="zoom-controls">
            <button
              type="button"
              onClick={() => zoomBy(0.8)}
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => zoomBy(1.25)}
              aria-label="Zoom in"
            >
              +
            </button>
            <button type="button" onClick={resetZoom}>
              Reset view
            </button>
          </div>
        )}
        <SelectionToolbar
          active={selectionActive}
          count={pendingChangeCount}
          onApply={onApplySelection}
          onCancel={onCancelSelection}
          fields={selectionFields}
          onSelectValues={onSelectValues}
        />
      </div>

      {mode === "sankey" ? (
        <div className="network-canvas sankey-canvas">
          <div className="network-axis-labels" aria-hidden="true">
            <span>MCP servers</span>
            <span>Users</span>
          </div>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            aria-label="Sankey relationship map from observed MCPs to users"
          >
            <g ref={rootRef}>
              <g className="sankey-links">
                {graph.layout.links.map((link, index) => {
                  const source = link.source as LayoutNode;
                  const target = link.target as LayoutNode;
                  const hoverActive =
                    source.id === hoveredId || target.id === hoveredId;
                  const selectionActive =
                    selectedNodeIds.has(source.id) ||
                    selectedNodeIds.has(target.id);
                  const opacity = hoveredId
                    ? hoverActive
                      ? 0.7
                      : 0.025
                    : hasSelections
                      ? selectionActive
                        ? 0.58
                        : 0.035
                      : 0.18;
                  return (
                    <path
                      key={`${source.id}-${target.id}-${index}`}
                      d={linkPath(link) ?? undefined}
                      className="sankey-link"
                      strokeWidth={link.width ?? 0}
                      opacity={opacity}
                    />
                  );
                })}
              </g>
              <g className="sankey-nodes">
                {graph.layout.nodes.map((node, nodeIndex) => {
                  const x0 = node.x0 ?? 0;
                  const x1 = node.x1 ?? x0 + 18;
                  const y0 = node.y0 ?? 0;
                  const y1 = node.y1 ?? y0 + 1;
                  const selected = selectedNodeIds.has(node.id);
                  const selectionGlyph = node.isOther
                    ? ""
                    : selected
                      ? hoveredId === node.id
                        ? "×"
                        : "✓"
                      : hoveredId === node.id
                        ? "+"
                        : "";
                  return (
                    <g
                      key={node.id}
                      className={`sankey-node ${node.kind}${node.isOther ? " other" : ""}${selected ? " selected" : ""}`}
                      opacity={isEmphasized(node.id) ? 1 : 0.18}
                      onPointerEnter={() => setHoveredId(node.id)}
                      onPointerLeave={() => {
                        if (
                          document.activeElement !== nodeRefs.current[nodeIndex]
                        ) {
                          setHoveredId(null);
                        }
                      }}
                      onClick={() => activateNode(node)}
                    >
                      <rect
                        ref={(element) => {
                          nodeRefs.current[nodeIndex] = element;
                        }}
                        x={x0}
                        y={y0}
                        width={x1 - x0}
                        height={Math.max(2, y1 - y0)}
                        rx={4}
                        role="button"
                        tabIndex={nodeIndex === activeNodeIndex ? 0 : -1}
                        aria-pressed={node.isOther ? undefined : selected}
                        aria-label={
                          node.isOther
                            ? `Inspect ${node.label}, ${node.usage.toLocaleString()} calls`
                            : `${selected ? "Remove" : "Add"} ${node.label}${node.email ? `, ${node.email}` : ""} ${node.kind === "server" ? "MCP" : "user"} filter, ${node.usage.toLocaleString()} calls`
                        }
                        aria-describedby={
                          hoveredId === node.id
                            ? "sankey-node-details"
                            : undefined
                        }
                        onFocus={() => {
                          setActiveNodeIndex(nodeIndex);
                          setHoveredId(node.id);
                        }}
                        onBlur={() =>
                          setHoveredId((current) =>
                            current === node.id ? null : current,
                          )
                        }
                        onKeyDown={(event) => {
                          let nextIndex = nodeIndex;
                          if (
                            event.key === "ArrowRight" ||
                            event.key === "ArrowDown"
                          ) {
                            nextIndex = Math.min(
                              nodeIndex + 1,
                              graph.layout.nodes.length - 1,
                            );
                          } else if (
                            event.key === "ArrowLeft" ||
                            event.key === "ArrowUp"
                          ) {
                            nextIndex = Math.max(nodeIndex - 1, 0);
                          } else if (event.key === "Home") {
                            nextIndex = 0;
                          } else if (event.key === "End") {
                            nextIndex = graph.layout.nodes.length - 1;
                          }
                          if (nextIndex !== nodeIndex) {
                            event.preventDefault();
                            setActiveNodeIndex(nextIndex);
                            nodeRefs.current[nextIndex]?.focus();
                            return;
                          }
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            activateNode(node);
                          }
                        }}
                      />
                      <text
                        x={node.kind === "server" ? x0 - 10 : x1 + 10}
                        y={(y0 + y1) / 2}
                        dy="0.35em"
                        textAnchor={node.kind === "server" ? "end" : "start"}
                      >
                        {node.label.length > 24
                          ? `${node.label.slice(0, 22)}…`
                          : node.label}
                      </text>
                      {selectionGlyph && (
                        <text
                          className="sankey-selection-glyph"
                          x={(x0 + x1) / 2}
                          y={(y0 + y1) / 2}
                          dy="0.35em"
                          textAnchor="middle"
                          aria-hidden="true"
                        >
                          {selectionGlyph}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>
          {hoveredNode && (
            <div
              id="sankey-node-details"
              className="network-hover-readout"
              role="status"
              aria-live="polite"
            >
              <strong>{hoveredNode.label}</strong>
              <span>
                {hoveredNode.email ? `${hoveredNode.email} · ` : ""}
                {hoveredNode.usage.toLocaleString()} calls
                {!hoveredNode.isOther &&
                  ` · Click to ${selectedNodeIds.has(hoveredNode.id) ? "remove" : "select"}`}
              </span>
            </div>
          )}
          <div className="network-legend">
            <span>
              <i className="legend-dot server" /> Observed MCP
            </span>
            <span>
              <i className="legend-line" /> Relative call flow
            </span>
            <span>
              <i className="legend-dot user" /> User
            </span>
            <span className="network-hint">
              Click to select · click again to remove
            </span>
          </div>
        </div>
      ) : (
        <div
          className="network-list-wrap"
          role="region"
          aria-label="Observed MCP relationship summary"
          tabIndex={0}
        >
          <table className="network-list">
            <thead>
              <tr>
                <th>MCP server</th>
                <th>User</th>
                <th>Email</th>
                <th>Calls</th>
                <th>
                  <span className="sr-only">Relationship filters</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRelationshipRows.map((link, index) => {
                const source = link.source as LayoutNode;
                const target = link.target as LayoutNode;
                const sourceSelected = selectedNodeIds.has(source.id);
                const targetSelected = selectedNodeIds.has(target.id);
                return (
                  <tr
                    key={`${source.id}-${target.id}-${listPage}-${index}`}
                    className={
                      sourceSelected || targetSelected ? "selected" : ""
                    }
                  >
                    <th>
                      {source.isOther ? (
                        source.label
                      ) : (
                        <McpServerLabel server={source.label} />
                      )}
                    </th>
                    <td data-label="User">{target.label}</td>
                    <td data-label="Email">
                      {target.email ?? "Grouped users"}
                    </td>
                    <td data-label="Calls">{link.usage.toLocaleString()}</td>
                    <td data-label="Relationship filters">
                      <button
                        type="button"
                        className="chart-selectable"
                        aria-pressed={
                          source.isOther ? undefined : sourceSelected
                        }
                        onClick={() => activateNode(source)}
                      >
                        {source.isOther
                          ? "Inspect MCPs"
                          : sourceSelected
                            ? "Remove MCP"
                            : "Select MCP"}
                      </button>
                      <button
                        type="button"
                        className="chart-selectable"
                        aria-pressed={
                          target.isOther ? undefined : targetSelected
                        }
                        onClick={() => activateNode(target)}
                      >
                        {target.isOther
                          ? "Inspect users"
                          : targetSelected
                            ? "Remove user"
                            : "Select user"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {listPageCount > 1 && (
            <div className="network-list-pagination">
              <button
                type="button"
                onClick={() => setListPage((page) => Math.max(0, page - 1))}
                disabled={listPage === 0}
              >
                Previous
              </button>
              <span role="status" aria-live="polite">
                Page {listPage + 1} of {listPageCount}
              </span>
              <button
                type="button"
                onClick={() =>
                  setListPage((page) => Math.min(listPageCount - 1, page + 1))
                }
                disabled={listPage === listPageCount - 1}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
