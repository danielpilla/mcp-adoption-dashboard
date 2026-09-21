import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  DateRange,
  McpRecord,
  McpSummary,
} from "../../contracts/mcp-response";
import type { AssociationOption } from "./associative-model";
import type { Filters, TemporalFilterField } from "./filter-model";
import type { SearchSelection } from "./global-search";
import type { KpiType } from "../analytics/kpi-drawer";
import type { PivotResult } from "../pivot/pivot-model";
import type { SelectionField } from "./selection-model";

export type DashboardPhase =
  "dashboard-phase" | "analysis-phase" | "reporting-phase";

export type ExportDataset = "activity" | "userMcp" | "pivot" | "emails";

interface ScopeFilterRequest {
  field: SelectionField | "query" | null;
  id: number;
}

type OverflowSelection = "servers" | "users";

export interface ScopeState {
  barRef: RefObject<HTMLElement | null>;
  stuck: boolean;
  rangeLabel: string;
  currentRange: DateRange;
  fullRange?: DateRange;
  dataAvailable: boolean;
  isSnapshot: boolean;
  filters: Filters;
  setFilters: Dispatch<SetStateAction<Filters>>;
  lockedFields: Set<SelectionField>;
  canReset: boolean;
  clearing: boolean;
  selectedKpi: KpiType | null;
  selectedServer: string | null;
  selectedOverflow: OverflowSelection | null;
  userOptions: AssociationOption[];
  onEditRange: () => void;
  onResetRange: (range: DateRange) => void;
  onReset: () => void;
  onCloseKpi: () => void;
  onCloseServer: () => void;
  onCloseOverflow: () => void;
}

interface NavigationState {
  activePhase: DashboardPhase;
  onSelectPhase: (phase: DashboardPhase) => void;
}

export interface FilterPanelState {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  request: ScopeFilterRequest;
  setRequest: Dispatch<SetStateAction<ScopeFilterRequest>>;
  records: McpRecord[];
  options: {
    origins: AssociationOption[];
    users: AssociationOption[];
    servers: AssociationOption[];
    tools: AssociationOption[];
    groups: AssociationOption[];
    time: Record<TemporalFilterField, AssociationOption[]>;
  };
  onSearchSelect: (selection: SearchSelection) => void;
  onToggleLock: (field: SelectionField) => void;
}

export interface ExportPanelState {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  wrapRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  busy: boolean;
  filtering: boolean;
  summary: McpSummary;
  activityRowCount: number;
  userCount: number;
  userMcpRowCount: number;
  pivot: PivotResult | null;
  snapshotAvailable: boolean;
  snapshotError: string;
  onClose: (restoreFocus?: boolean) => void;
  onSelectDataset: (dataset: ExportDataset) => void;
  onSnapshot: () => void;
}

export interface DashboardScopeBarProps {
  scope: ScopeState;
  navigation: NavigationState;
  filterPanel: FilterPanelState;
  exportPanel: ExportPanelState;
}
