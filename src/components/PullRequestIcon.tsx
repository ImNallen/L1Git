import {
  createLucideIcon,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { IconNode, LucideIcon } from "lucide-react";
import { stateLabels } from "../domain/pullRequestList";
import type { RowState } from "../domain/pullRequestList";

const branch: IconNode = [
  ["circle", { cx: "6", cy: "6", r: "3", key: "from" }],
  ["path", { d: "M6 9v12", key: "stem" }],
  ["path", { d: "M13 6h3a2 2 0 0 1 2 2v4", key: "to" }],
];
const GitPullRequestFailing = createLucideIcon("GitPullRequestFailing", [
  ...branch,
  ["path", { d: "m15.5 15.5 5 5", key: "down" }],
  ["path", { d: "m20.5 15.5-5 5", key: "up" }],
]);
const GitPullRequestReady = createLucideIcon("GitPullRequestReady", [
  ...branch,
  ["path", { d: "m14.5 18.5 2.5 2.5 5-5", key: "check" }],
]);

const icons: Record<RowState, LucideIcon> = {
  draft: GitPullRequestDraft,
  failing: GitPullRequestFailing,
  running: GitPullRequest,
  ready: GitPullRequestReady,
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

export function PullRequestIcon({ state }: { state: RowState }) {
  const Icon = icons[state];
  return (
    <span className={`pull-state ${state}`} title={stateLabels[state]}>
      <Icon size={16} strokeWidth={2} />
    </span>
  );
}
