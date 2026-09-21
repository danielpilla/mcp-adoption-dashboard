import type { ReactNode } from "react";
import { Icon } from "../interface/icon";

export function ScopeSelectionChip({
  className = "",
  children,
  locked = false,
  openLabel,
  removeLabel,
  onOpen,
  onRemove,
}: {
  className?: string;
  children: ReactNode;
  locked?: boolean;
  openLabel?: string;
  removeLabel: string;
  onOpen?: () => void;
  onRemove: () => void;
}) {
  return (
    <span className={`scope-chip ${className}${locked ? " locked" : ""}`}>
      {onOpen ? (
        <button
          type="button"
          className="scope-chip-main"
          onClick={onOpen}
          aria-label={openLabel}
        >
          {children}
        </button>
      ) : (
        <span className="scope-chip-main">{children}</span>
      )}
      {locked ? (
        <span className="scope-chip-lock" aria-label="Locked">
          <Icon name="lock" size={11} />
        </span>
      ) : (
        <button
          type="button"
          className="scope-chip-remove"
          onClick={(event) => {
            const container = event.currentTarget.closest(
              ".selection-bar, .drawer-scope-panel",
            );
            const controls = container
              ? [
                  ...container.querySelectorAll<HTMLElement>(
                    ".scope-chip button:not(:disabled), .scope-filter-toggle, .multi-filter-trigger, .global-search input",
                  ),
                ]
              : [];
            const currentIndex = controls.indexOf(event.currentTarget);
            const adjacent =
              controls[currentIndex + 1] ?? controls[currentIndex - 1];
            onRemove();
            window.setTimeout(() => {
              if (adjacent?.isConnected) {
                adjacent.focus();
                return;
              }
              container
                ?.querySelector<HTMLElement>(
                  ".scope-filter-toggle, .multi-filter-trigger, .global-search input, button:not(:disabled)",
                )
                ?.focus();
            });
          }}
          aria-label={removeLabel}
        >
          ×
        </button>
      )}
    </span>
  );
}
