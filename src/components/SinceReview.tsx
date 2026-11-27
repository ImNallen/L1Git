import { GitCompare, History } from "lucide-react";
import { counted } from "../domain/pullRequestDetail";
import { shortOid } from "../domain/shortOid";
import { baseWords, sinceStopText } from "../domain/sinceReview";
import { sinceShown } from "../filesChanged";
import type { FilesChanged as Held, Since } from "../filesChanged";
import { Avatar, Ago } from "./PullRequestParts";

/** All changes or Since your last review, and the review it compares with. */
export function SinceBar({
  held,
  since,
  viewer,
  onShow,
  onRetry,
}: {
  held: Held;
  since: Since;
  viewer: string;
  onShow: (showing: Since["showing"]) => void;
  onRetry: () => void;
}) {
  const { point, read } = since;
  if (read.kind === "stopped") {
    const { text, detail, retry } = sinceStopText(
      read.stop,
      point,
      held.range.repository.github,
    );
    return (
      <div className="notice info-notice since-stopped" role="status">
        <History size={14} aria-hidden="true" />
        <span>
          {text}
          {detail !== null && (
            <span className="since-stopped-detail"> {detail}</span>
          )}
        </span>
        {retry && (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  const again = sinceShown(held)?.groups.again.length ?? null;
  const all =
    held.read.kind === "ready"
      ? held.read.files.length
      : held.counted.changedFiles;
  const choices = [
    { showing: "all", label: "All changes", count: all },
    { showing: "since", label: "Since your last review", count: again },
  ] as const;
  return (
    <div className="since-bar">
      <div className="since-toggle" role="group" aria-label="Changes shown">
        {choices.map(({ showing, label, count }) => (
          <button
            key={showing}
            type="button"
            aria-pressed={since.showing === showing}
            onClick={() => onShow(showing)}
          >
            {label}
            {count !== null && (
              <span className="since-count">{count.toLocaleString()}</span>
            )}
          </button>
        ))}
      </div>
      {point.oid !== null && (
        <span className="since-reviewed">
          <Avatar login={viewer} />
          <span>
            You reviewed <code>{shortOid(point.oid)}</code>{" "}
            <Ago at={point.at} />.
          </span>
        </span>
      )}
    </div>
  );
}

/** What the since view says of the base branch, and of the files only it changed. */
export function SinceNotice({
  held,
  since,
  viewer,
  onRebased,
}: {
  held: Held;
  since: Since;
  viewer: string;
  onRebased: (rebased: Since["rebased"]) => void;
}) {
  const shown = sinceShown(held);
  if (since.showing !== "since" || since.read.kind !== "ready" || !shown)
    return null;
  const base = held.range.base;
  const words = baseWords(since.read.fromBase, held.pull, since.point, viewer);
  const count = shown.groups.rebased.length;
  const isShown = since.rebased === "shown";
  const files = counted(count, "file");
  const rebased =
    count === 0
      ? null
      : isShown
        ? `${files} changed only because of ${base}, listed after the others.`
        : `${files} changed only because of ${base}, so ${count === 1 ? "it's" : "they're"} hidden.`;
  if (words === null && rebased === null) return null;
  return (
    <div className="notice info-notice since-notice" role="status">
      <GitCompare size={14} aria-hidden="true" />
      <span>{[words, rebased].filter((each) => each !== null).join(" ")}</span>
      {count > 0 && (
        <button
          type="button"
          onClick={() => onRebased(isShown ? "folded" : "shown")}
        >
          {isShown ? "Hide them" : "Show them"}
        </button>
      )}
    </div>
  );
}
