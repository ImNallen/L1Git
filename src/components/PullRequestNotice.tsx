import { Plug, TriangleAlert } from "lucide-react";
import type { Notice } from "../domain/pullRequestList";
import { relativeTime } from "../domain/time";

/** "14:02", with the day once it is not today. */
export function clock(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { timeStyle: "short" });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString()} ${time}`;
}

export function PullRequestNotice({
  notice,
  shows,
  onRefresh,
}: {
  notice: Notice;
  /** What is shown meanwhile. */
  shows: string;
  onRefresh: (() => void) | null;
}) {
  switch (notice.kind) {
    case "offline":
      return (
        <div className="notice info-notice" role="status">
          <Plug size={14} />
          <span>
            {notice.at === null
              ? "Offline. No pull requests were read yet."
              : `Offline. Showing ${shows} as of ${clock(notice.at)}, ${relativeTime(notice.at / 1_000)}.`}
          </span>
          <button type="button" onClick={onRefresh ?? undefined}>
            Try again
          </button>
        </div>
      );
    case "connection":
      return (
        <div className="notice warning-notice" role="status">
          <TriangleAlert size={14} />
          <span>{notice.message}</span>
          <button type="button" onClick={onRefresh ?? undefined}>
            Try again
          </button>
        </div>
      );
    case "repository":
      return (
        <div className="notice warning-notice" role="status">
          <TriangleAlert size={14} />
          <span>
            <strong>Couldn&apos;t read {notice.repository.name}.</strong>{" "}
            {notice.message}
          </span>
          {notice.authorize !== null && (
            <a href={notice.authorize} target="_blank" rel="noreferrer">
              Authorize on GitHub
            </a>
          )}
        </div>
      );
    case "more":
      return (
        <div className="notice warning-notice" role="status">
          <TriangleAlert size={14} />
          <span>And {notice.count.toLocaleString()} more.</span>
        </div>
      );
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}
