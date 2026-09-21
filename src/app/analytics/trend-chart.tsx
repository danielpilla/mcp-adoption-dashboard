import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { McpRecord } from "../../contracts/mcp-response";
import {
  continuousDailySeries,
  formatNumber,
  type DailyMetric,
} from "./activity-metrics";
import { formatIsoDate } from "../dashboard/dashboard-dates";

export function TrendChart({
  records,
  compact = false,
  gradientId = "trend-gradient",
  onSelectDates,
  onToggleDate,
  selectedDates = [],
  startDate: requestedStartDate,
  endDate: requestedEndDate,
  metric = "usage",
  showValues = false,
}: {
  records: McpRecord[];
  compact?: boolean;
  gradientId?: string;
  onSelectDates?: (dates: string[]) => void;
  onToggleDate?: (date: string) => void;
  selectedDates?: string[];
  startDate?: string;
  endDate?: string;
  metric?: DailyMetric;
  showValues?: boolean;
}) {
  const metricLabel =
    metric === "usage"
      ? "MCP calls"
      : metric === "users"
        ? "distinct users"
        : metric === "servers"
          ? "observed MCPs"
          : "MCP–tool pairs";
  const recordDates = records
    .map((record) => record.date)
    .sort((left, right) => left.localeCompare(right));
  const startDate = requestedStartDate ?? recordDates[0] ?? "";
  const endDate = requestedEndDate ?? recordDates.at(-1) ?? startDate;
  const points = useMemo(
    () => continuousDailySeries(records, metric, startDate, endDate),
    [endDate, metric, records, startDate],
  );
  const width = 900;
  const height = compact ? 190 : 260;
  const padding = compact
    ? { top: 18, right: 12, bottom: 26, left: 12 }
    : { top: 24, right: 22, bottom: 38, left: 54 };
  const max = Math.max(...points.map(([, usage]) => usage), 1);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const yScale = d3
    .scaleLinear()
    .domain([0, max])
    .nice(2)
    .range([padding.top + innerHeight, padding.top]);
  const yTicks = yScale.ticks(2).filter(Number.isInteger).reverse();
  const brushRef = useRef<SVGGElement>(null);
  const pointRefs = useRef<Array<SVGCircleElement | null>>([]);
  const [activePointIndex, setActivePointIndex] = useState(0);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(
    null,
  );

  useEffect(() => {
    const group = brushRef.current;
    if (
      !group ||
      compact ||
      (!onSelectDates && !onToggleDate) ||
      points.length === 0
    )
      return;
    const indexForX = (x: number) =>
      Math.max(
        0,
        Math.min(
          points.length - 1,
          Math.round(((x - padding.left) / innerWidth) * (points.length - 1)),
        ),
      );
    const brush = d3
      .brushX<unknown>()
      .extent([
        [padding.left, padding.top],
        [padding.left + innerWidth, padding.top + innerHeight],
      ])
      .on("end", (event) => {
        if (!event.sourceEvent) return;
        let startIndex: number;
        let endIndex: number;
        if (event.selection) {
          const [startX, endX] = event.selection as [number, number];
          startIndex = indexForX(startX);
          endIndex = indexForX(endX);
        } else {
          const svg = group.ownerSVGElement;
          const bounds = svg?.getBoundingClientRect();
          if (!bounds) return;
          const viewX =
            ((event.sourceEvent.clientX - bounds.left) / bounds.width) * width;
          startIndex = indexForX(viewX);
          endIndex = startIndex;
        }
        if (!event.selection && onToggleDate) {
          const point = points[startIndex];
          if (!point) return;
          onToggleDate(point[0]);
          d3.select(group).call(brush.move, null);
          return;
        }
        if (!onSelectDates) return;
        onSelectDates(
          points
            .slice(
              Math.min(startIndex, endIndex),
              Math.max(startIndex, endIndex) + 1,
            )
            .map(([date]) => date),
        );
        d3.select(group).call(brush.move, null);
      });
    d3.select(group).call(brush);
    return () => {
      d3.select(group).on(".brush", null);
    };
  }, [
    compact,
    innerHeight,
    innerWidth,
    onSelectDates,
    onToggleDate,
    padding.left,
    padding.top,
    points,
  ]);

  if (points.length === 0) {
    return <div className="chart-empty">No usage in this range</div>;
  }

  const coordinates = points.map(([date, usage], index) => ({
    date,
    usage,
    x:
      padding.left +
      (points.length === 1
        ? innerWidth / 2
        : (index / (points.length - 1)) * innerWidth),
    y: yScale(usage),
  }));
  const firstCoordinate = coordinates[0];
  const lastCoordinate = coordinates.at(-1);
  if (!firstCoordinate || !lastCoordinate) {
    return <div className="chart-empty">No usage in this range</div>;
  }
  const activityIndexes = coordinates.flatMap((point, index) =>
    point.usage > 0 ? [index] : [],
  );
  if (activityIndexes.length === 0) {
    return (
      <div className="chart-empty">No recorded activity in this range</div>
    );
  }
  const line = coordinates
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");
  const area =
    `${line} L${lastCoordinate.x},${padding.top + innerHeight}` +
    ` L${firstCoordinate.x},${padding.top + innerHeight} Z`;
  const labelIndexes = new Set([
    0,
    Math.floor((points.length - 1) / 2),
    points.length - 1,
  ]);
  const selectPoint = (index: number) => {
    const date = points[index]?.[0];
    if (date && onToggleDate) {
      onToggleDate(date);
    } else if (date && onSelectDates) {
      onSelectDates([date]);
    }
  };
  const interactiveIndexes = activityIndexes;
  const keyboardActiveIndex = interactiveIndexes.includes(activePointIndex)
    ? activePointIndex
    : (interactiveIndexes[0] ?? 0);
  const valueLabelIndexes = new Set<number>();
  if (showValues && !compact) {
    if (coordinates.length <= 31) {
      activityIndexes.forEach((index) => valueLabelIndexes.add(index));
    } else {
      const candidates = activityIndexes
        .flatMap((index) => {
          const point = coordinates[index];
          return point ? [{ ...point, index }] : [];
        })
        .sort((left, right) => right.usage - left.usage);
      for (const candidate of candidates) {
        if (
          valueLabelIndexes.size >= 12 ||
          [...valueLabelIndexes].some((index) => {
            const point = coordinates[index];
            return point ? Math.abs(point.x - candidate.x) < 58 : false;
          })
        ) {
          continue;
        }
        valueLabelIndexes.add(candidate.index);
      }
    }
  }
  const hoveredPoint =
    hoveredPointIndex === null
      ? null
      : (coordinates[hoveredPointIndex] ?? null);
  const tooltipHorizontal =
    !hoveredPoint || hoveredPoint.x > width - 120
      ? "right"
      : hoveredPoint.x < 120
        ? "left"
        : "center";

  return (
    <div className={`trend-chart-shell${compact ? " compact" : ""}`}>
      <span className="sr-only">
        {points
          .map(
            ([date, value]) =>
              `${date}: ${value.toLocaleString()} ${metricLabel}`,
          )
          .join("; ")}
      </span>
      <svg
        className={`trend-chart${compact ? " compact" : ""}`}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={`Daily ${metricLabel} trend${compact ? "" : ". Use arrow keys to move between selectable dates."}`}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const viewX = ((event.clientX - bounds.left) / bounds.width) * width;
          const viewY = ((event.clientY - bounds.top) / bounds.height) * height;
          if (
            viewX < padding.left ||
            viewX > width - padding.right ||
            viewY < padding.top ||
            viewY > padding.top + innerHeight
          ) {
            setHoveredPointIndex(null);
            return;
          }
          const firstActivityIndex = activityIndexes[0];
          const lastActivityIndex = activityIndexes.at(-1);
          if (
            firstActivityIndex === undefined ||
            lastActivityIndex === undefined
          ) {
            setHoveredPointIndex(null);
            return;
          }
          const firstActivity = coordinates[firstActivityIndex];
          const lastActivity = coordinates[lastActivityIndex];
          if (!firstActivity || !lastActivity) return;
          if (viewX < firstActivity.x || viewX > lastActivity.x) {
            setHoveredPointIndex(null);
            return;
          }
          const index = activityIndexes.reduce((nearest, candidate) =>
            Math.abs((coordinates[candidate]?.x ?? 0) - viewX) <
            Math.abs((coordinates[nearest]?.x ?? 0) - viewX)
              ? candidate
              : nearest,
          );
          setHoveredPointIndex(index);
        }}
        onPointerLeave={() => setHoveredPointIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#36a6ff" stopOpacity=".38" />
            <stop offset="100%" stopColor="#36a6ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {!compact &&
          yTicks.map((value) => {
            const y = yScale(value);
            return (
              <g key={value}>
                <line
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y}
                  y2={y}
                  className="chart-grid"
                />
                <text x={padding.left - 12} y={y + 4} className="chart-y-label">
                  {formatNumber(value)}
                </text>
              </g>
            );
          })}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} className="chart-line" />
        {coordinates.map((point, index) => {
          const selected = selectedDates.includes(point.date);
          const hasActivity = point.usage > 0;
          const interactive = Boolean(
            !compact && (onToggleDate || onSelectDates),
          );
          const pointInteractive =
            interactive && interactiveIndexes.includes(index);
          return (
            <g
              key={`${point.date}-${index}`}
              className={selected ? "selected" : ""}
            >
              {hasActivity && point.y !== null && point.usage !== null && (
                <>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={compact ? 2.5 : 3.5}
                    className={`chart-point visual${selected ? " selected" : ""}`}
                    aria-hidden="true"
                  >
                    <title>
                      {point.date}: {point.usage.toLocaleString()} {metricLabel}
                    </title>
                  </circle>
                  {pointInteractive && (
                    <circle
                      ref={(element) => {
                        pointRefs.current[index] = element;
                      }}
                      cx={point.x}
                      cy={point.y}
                      r={32}
                      className="chart-point interactive target"
                      role="button"
                      tabIndex={index === keyboardActiveIndex ? 0 : -1}
                      aria-label={`${selected ? "Remove" : "Add"} ${point.date} date filter, ${point.usage.toLocaleString()} ${metricLabel}`}
                      aria-pressed={selected}
                      aria-posinset={interactiveIndexes.indexOf(index) + 1}
                      aria-setsize={interactiveIndexes.length}
                      onFocus={() => {
                        setActivePointIndex(index);
                        setHoveredPointIndex(index);
                      }}
                      onBlur={() => setHoveredPointIndex(null)}
                      onClick={() => selectPoint(index)}
                      onKeyDown={(event) => {
                        const position = interactiveIndexes.indexOf(index);
                        let nextPosition = position;
                        if (
                          event.key === "ArrowRight" ||
                          event.key === "ArrowDown"
                        ) {
                          nextPosition = Math.min(
                            position + 1,
                            interactiveIndexes.length - 1,
                          );
                        } else if (
                          event.key === "ArrowLeft" ||
                          event.key === "ArrowUp"
                        ) {
                          nextPosition = Math.max(position - 1, 0);
                        } else if (event.key === "Home") {
                          nextPosition = 0;
                        } else if (event.key === "End") {
                          nextPosition = interactiveIndexes.length - 1;
                        }
                        const nextIndex = interactiveIndexes[nextPosition];
                        if (nextIndex !== undefined && nextIndex !== index) {
                          event.preventDefault();
                          setActivePointIndex(nextIndex);
                          pointRefs.current[nextIndex]?.focus();
                          return;
                        }
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectPoint(index);
                        }
                      }}
                    />
                  )}
                  {valueLabelIndexes.has(index) && (
                    <text
                      x={point.x}
                      y={Math.max(padding.top + 10, point.y - 11)}
                      className="chart-point-value"
                      textAnchor="middle"
                      aria-hidden="true"
                    >
                      {formatNumber(point.usage)}
                    </text>
                  )}
                  {selected && !compact && (
                    <text
                      x={point.x}
                      y={point.y - (valueLabelIndexes.has(index) ? 25 : 10)}
                      className="chart-point-check"
                      textAnchor="middle"
                      aria-hidden="true"
                    >
                      ✓
                    </text>
                  )}
                </>
              )}
              {!compact && labelIndexes.has(index) && (
                <text
                  x={point.x}
                  y={height - 10}
                  textAnchor={
                    index === 0
                      ? "start"
                      : index === points.length - 1
                        ? "end"
                        : "middle"
                  }
                  className="chart-x-label"
                >
                  {formatIsoDate(point.date, {
                    month: "short",
                    day: "numeric",
                  })}
                </text>
              )}
            </g>
          );
        })}
        {(onSelectDates || onToggleDate) && !compact && (
          <g ref={brushRef} className="chart-brush" />
        )}
      </svg>
      {hoveredPoint && (
        <div
          className={`trend-point-tooltip ${tooltipHorizontal} ${
            hoveredPoint.y < padding.top + 70 ? "below" : ""
          }`}
          style={{
            left: `${(hoveredPoint.x / width) * 100}%`,
            top: `${(hoveredPoint.y / height) * 100}%`,
          }}
          role="tooltip"
        >
          <strong>
            {formatIsoDate(hoveredPoint.date, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </strong>
          <span>
            {hoveredPoint.usage.toLocaleString()} {metricLabel}
          </span>
        </div>
      )}
    </div>
  );
}
