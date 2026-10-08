import type {
  DateRange,
  McpResponseNotice,
} from "../../contracts/mcp-response";
import type { DirectoryLoadProgress } from "./dashboard-stream";
import { describeDirectoryProgress } from "./directory-progress";

export function DashboardNotices({
  notices,
  directory,
  activeRange,
  onShowFrom,
}: {
  notices: readonly McpResponseNotice[];
  activeRange: DateRange;
  /** Live directory progress, shown instead of the progress in a loading notice. */
  directory: DirectoryLoadProgress | null;
  /** Narrows the view to the complete days, starting on `date`. */
  onShowFrom?: (date: string) => void;
}) {
  if (notices.length === 0) return null;
  const title = notices.some((notice) => notice.code === "LIMIT_REACHED")
    ? "Showing partial data"
    : notices.some((notice) => notice.code === "DIRECTORY_LOADING")
      ? "Directory groups still loading"
      : "Directory groups unavailable";
  return (
    <section
      className="state-card notice-state"
      role="status"
      aria-labelledby="data-notice-title"
    >
      <div className="state-icon">i</div>
      <div>
        <h2 id="data-notice-title">{title}</h2>
        <ul className="notice-list">
          {notices.map((notice, index) => (
            <li key={`${notice.code}-${notice.setting ?? ""}-${index}`}>
              <p>
                {notice.code === "DIRECTORY_LOADING" && directory
                  ? `Directory groups are still loading (${describeDirectoryProgress(directory)}). Names, roles, and group filters update automatically when loading finishes.`
                  : notice.message}
              </p>
              {notice.completeFrom &&
                notice.completeFrom > activeRange.startDate &&
                notice.completeFrom <= activeRange.endDate &&
                onShowFrom && (
                  <button
                    type="button"
                    onClick={() => onShowFrom(notice.completeFrom ?? "")}
                  >
                    Show complete days from {notice.completeFrom}
                  </button>
                )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
