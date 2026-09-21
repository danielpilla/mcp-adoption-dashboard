import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { type DateRange, type McpResponse } from "../../contracts/mcp-response";
import { ingestDashboardResponse } from "./dashboard-response";
import { isJsonObject, optionalString } from "./dashboard-api-client";

interface DashboardDataLoadOptions {
  force?: boolean;
  preserveActiveRange?: boolean;
}

interface FailedDashboardLoad {
  range: DateRange;
  options: DashboardDataLoadOptions;
}

interface UseDashboardDataOptions {
  initialData: McpResponse | null;
  initialRange: DateRange;
  onSetupRequired?: () => void;
  onBeforeRangeChange: () => void;
}

interface DashboardDataState {
  data: McpResponse | null;
  loading: boolean;
  blockingLoad: boolean;
  refreshError: boolean;
  transitionPending: boolean;
  error: string;
  activeRange: DateRange;
  draftRange: DateRange;
}

interface DashboardDataActions {
  loadData: (
    range: DateRange,
    options?: DashboardDataLoadOptions,
  ) => Promise<void>;
  applyRange: (range: DateRange) => Promise<void>;
  updateRange: (range: DateRange) => void;
  drillToRange: (range: DateRange) => void;
  refreshData: () => void;
  retryFailedLoad: () => void;
}

export interface DashboardDataController {
  state: DashboardDataState;
  actions: DashboardDataActions;
}

export function useDashboardData({
  initialData,
  initialRange,
  onSetupRequired,
  onBeforeRangeChange,
}: UseDashboardDataOptions): DashboardDataController {
  const [draftRange, setDraftRange] = useState(initialRange);
  const [activeRange, setActiveRange] = useState(initialRange);
  const activeRangeRef = useRef(initialRange);
  const [data, setData] = useState<McpResponse | null>(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [blockingLoad, setBlockingLoad] = useState(!initialData);
  const [refreshError, setRefreshError] = useState(false);
  const [error, setError] = useState("");
  const [failedLoad, setFailedLoad] = useState<FailedDashboardLoad | null>(
    null,
  );
  const [transitionPending, startTransition] = useTransition();
  const loadRequestRef = useRef<{
    id: number;
    controller: AbortController;
  } | null>(null);
  const nextLoadRequestIdRef = useRef(0);
  const isSnapshot = initialData?.source === "snapshot";

  const loadData = useCallback(
    async (range: DateRange, options: DashboardDataLoadOptions = {}) => {
      loadRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestId = ++nextLoadRequestIdRef.current;
      loadRequestRef.current = { id: requestId, controller };
      setLoading(true);
      setBlockingLoad(!options.preserveActiveRange);
      setRefreshError(false);
      setError("");
      setFailedLoad(null);
      try {
        const query = new URLSearchParams({
          ...range,
          ...(options.force ? { refresh: "1" } : {}),
        });
        const response = await fetch(`/api/mcp?${query}`, {
          signal: controller.signal,
        });
        const body: unknown = await response.json();
        const errorBody = isJsonObject(body) ? body : {};
        if (loadRequestRef.current?.id !== requestId) return;
        if (response.status === 428 && errorBody.code === "SETUP_REQUIRED") {
          onSetupRequired?.();
          return;
        }
        if (!response.ok) {
          throw new Error(
            optionalString(errorBody.error) || "Could not load MCP analytics.",
          );
        }
        const payload = ingestDashboardResponse(body);
        startTransition(() => {
          setData(payload);
          if (!options.preserveActiveRange) {
            activeRangeRef.current = range;
            setActiveRange(range);
            setDraftRange(range);
          }
        });
      } catch (loadError) {
        if (
          controller.signal.aborted ||
          loadRequestRef.current?.id !== requestId
        ) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load MCP analytics.",
        );
        setRefreshError(options.preserveActiveRange === true);
        if (!options.preserveActiveRange) {
          setDraftRange(activeRangeRef.current);
        }
        setFailedLoad({ range, options: { ...options } });
      } finally {
        if (loadRequestRef.current?.id === requestId) {
          loadRequestRef.current = null;
          setLoading(false);
          setBlockingLoad(false);
        }
      }
    },
    [onSetupRequired],
  );

  useEffect(() => {
    if (!initialData) void loadData(initialRange);
  }, [initialData, initialRange, loadData]);

  useEffect(
    () => () => {
      loadRequestRef.current?.controller.abort();
      loadRequestRef.current = null;
    },
    [],
  );

  const applyRange = useCallback(
    async (range: DateRange) => {
      if (
        data &&
        range.startDate >= data.range.startDate &&
        range.endDate <= data.range.endDate
      ) {
        loadRequestRef.current?.controller.abort();
        loadRequestRef.current = null;
        nextLoadRequestIdRef.current += 1;
        setLoading(false);
        setBlockingLoad(false);
        setRefreshError(false);
        setError("");
        setFailedLoad(null);
        startTransition(() => {
          activeRangeRef.current = range;
          setActiveRange(range);
        });
        return;
      }
      await loadData(range);
    },
    [data, loadData],
  );

  const updateRange = useCallback(
    (range: DateRange) => {
      onBeforeRangeChange();
      setDraftRange(range);
      if (
        range.startDate &&
        range.endDate &&
        range.startDate <= range.endDate
      ) {
        void applyRange(range);
      }
    },
    [applyRange, onBeforeRangeChange],
  );

  const drillToRange = useCallback(
    (range: DateRange) => {
      onBeforeRangeChange();
      setDraftRange(range);
      void applyRange(range);
    },
    [applyRange, onBeforeRangeChange],
  );

  const refreshData = useCallback(() => {
    if (!data || isSnapshot) return;
    void loadData(data.range, {
      force: true,
      preserveActiveRange: true,
    });
  }, [data, isSnapshot, loadData]);

  const retryFailedLoad = useCallback(() => {
    void loadData(failedLoad?.range ?? activeRange, failedLoad?.options);
  }, [activeRange, failedLoad, loadData]);

  return {
    state: {
      data,
      loading,
      blockingLoad,
      refreshError,
      transitionPending,
      error,
      activeRange,
      draftRange,
    },
    actions: {
      loadData,
      applyRange,
      updateRange,
      drillToRange,
      refreshData,
      retryFailedLoad,
    },
  };
}
