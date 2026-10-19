import { ArrowDown, ArrowUp } from "lucide-react";
import { upstreamName } from "../domain/overview";
import type { Divergence } from "../domain/overview";

export function SyncCounts({
  divergence: { upstream, ahead, behind },
  branch,
}: {
  divergence: Divergence;
  branch?: string;
}) {
  if (ahead === 0 && behind === 0) return null;
  const commits = (count: number) =>
    count === 1 ? "1 commit" : `${count} commits`;
  const label: string[] = [];
  const title: string[] = [];
  if (behind > 0) {
    label.push(`${behind} to pull`);
    title.push(`${commits(behind)} to pull from ${upstreamName(upstream)}`);
  }
  if (ahead > 0) {
    label.push(`${ahead} to push`);
    title.push(
      behind > 0
        ? `${commits(ahead)} to push`
        : `${commits(ahead)} to push to ${upstreamName(upstream)}`,
    );
  }
  const prefix = branch === undefined ? "" : `${branch}: `;
  return (
    <span
      className="sync-counts"
      role="img"
      aria-label={prefix + label.join(", ")}
      title={prefix + title.join(" · ")}
    >
      {behind > 0 && (
        <span className="incoming">
          <ArrowDown size={11} />
          {behind}
        </span>
      )}
      {ahead > 0 && (
        <span className="outgoing">
          <ArrowUp size={11} />
          {ahead}
        </span>
      )}
    </span>
  );
}
