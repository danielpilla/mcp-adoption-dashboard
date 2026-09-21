import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardPhase } from "../scope/scope-contract";

function phaseFromHash(): DashboardPhase | null {
  const phase = `${window.location.hash.slice(1)}-phase`;
  return phase === "dashboard-phase" ||
    phase === "analysis-phase" ||
    phase === "reporting-phase"
    ? phase
    : null;
}

function hashForPhase(phase: DashboardPhase): string {
  return `#${phase.replace("-phase", "")}`;
}

function scrollToPhase(phase: DashboardPhase, smooth: boolean) {
  window.requestAnimationFrame(() => {
    document.getElementById(phase)?.scrollIntoView({
      behavior:
        smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "auto",
      block: "start",
    });
  });
}

export function useDashboardPhaseNavigation(enabled: boolean) {
  const [activePhase, setActivePhase] = useState<DashboardPhase>(
    () => phaseFromHash() ?? "dashboard-phase",
  );
  const [scopeBarStuck, setScopeBarStuck] = useState(false);
  const selectionBarRef = useRef<HTMLElement>(null);

  const selectPhase = useCallback((phase: DashboardPhase) => {
    setActivePhase(phase);
    window.history.replaceState(null, "", hashForPhase(phase));
    scrollToPhase(phase, true);
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const phase = phaseFromHash();
      if (!phase) return;
      setActivePhase(phase);
      scrollToPhase(phase, false);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const phase = phaseFromHash();
    if (enabled && phase) scrollToPhase(phase, false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const updateNavigation = () => {
      const selectionBarTop =
        selectionBarRef.current?.getBoundingClientRect().top;
      setScopeBarStuck(
        selectionBarTop !== undefined &&
          selectionBarTop <= 0 &&
          window.scrollY > 0,
      );
      const nextPhase =
        (
          [
            "reporting-phase",
            "analysis-phase",
            "dashboard-phase",
          ] as DashboardPhase[]
        ).find((phase) => {
          const section = document.getElementById(phase);
          return section && section.getBoundingClientRect().top <= 160;
        }) ?? "dashboard-phase";
      setActivePhase(nextPhase);
      const nextHash = hashForPhase(nextPhase);
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", nextHash);
      }
    };
    updateNavigation();
    window.addEventListener("scroll", updateNavigation, { passive: true });
    return () => window.removeEventListener("scroll", updateNavigation);
  }, [enabled]);

  return {
    activePhase,
    scopeBarStuck,
    selectionBarRef,
    selectPhase,
  };
}
