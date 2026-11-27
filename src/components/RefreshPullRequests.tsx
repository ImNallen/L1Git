import { RefreshCw } from "lucide-react";

export function RefreshPullRequests({
  reading,
  onRefresh,
}: {
  reading: boolean;
  /** Null while there is no sign-in to read with. */
  onRefresh: (() => void) | null;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label="Refresh pull requests"
      title="Refresh pull requests"
      aria-disabled={onRefresh === null}
      onClick={onRefresh ?? undefined}
    >
      <RefreshCw size={14} className={reading ? "spin" : undefined} />
    </button>
  );
}
