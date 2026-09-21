import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function visibleFocusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden",
  );
}

export function useDialogFocusTrap<T extends HTMLElement>(
  active: boolean,
  focusKey: unknown = active,
) {
  const dialogRef = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const layer = dialog.parentElement;
    const siblings = layer?.parentElement
      ? [...layer.parentElement.children].filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element !== layer,
        )
      : [];
    const previousBodyOverflow = document.body.style.overflow;
    const siblingStates = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    document.body.style.overflow = "hidden";
    for (const sibling of siblings) {
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }

    const focusTimer = window.setTimeout(() => {
      const initial =
        dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
        visibleFocusableElements(dialog)[0] ??
        dialog;
      initial.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = visibleFocusableElements(dialog);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      for (const state of siblingStates) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) {
          state.element.removeAttribute("aria-hidden");
        } else {
          state.element.setAttribute("aria-hidden", state.ariaHidden);
        }
      }
      opener?.focus();
    };
  }, [active, focusKey]);

  return dialogRef;
}
