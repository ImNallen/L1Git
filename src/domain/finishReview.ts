import { draftText } from "./drafts";
import type { LineAnchor } from "./lineComments";
import type { PullRequest, ReviewThread } from "./pullRequest";
import { whose } from "./pullRequestDetail";
import type { PullWrite } from "./pullRequestWrites";
import type { RangeFile } from "./range";
import type { Oid } from "./repository";

export type ReviewEvent = Extract<PullWrite, { kind: "submitReview" }>["event"];

/** A pending comment, as Finish review sends it. */
type Pending = { anchor: LineAnchor; head: Oid; text: string };

/**
 * A review goes with one commit, the head GitHub has now. Pending comments
 * written against it send; the rest are listed and never sent, since their
 * line numbers mean something at another commit only.
 */
export function byHead<Draft extends { head: Oid }>(
  drafts: readonly Draft[],
  head: Oid,
): { current: Draft[]; older: Draft[] } {
  return {
    current: drafts.filter((draft) => draft.head === head),
    older: drafts.filter((draft) => draft.head !== head),
  };
}

/** GitHub lets you comment on your own pull request, and nothing more. */
export const eventsFor = ({
  viewerIsAuthor,
}: Pick<PullRequest, "viewerIsAuthor">): readonly ReviewEvent[] =>
  viewerIsAuthor ? ["comment"] : ["comment", "approve", "requestChanges"];

/** Why the review can't be sent as it is, or null when it can. */
export function heldBack({
  event,
  summary,
  comments,
}: {
  event: ReviewEvent;
  summary: string;
  comments: number;
}): string | null {
  const words = draftText(summary);
  if (words === "tooLong")
    return "GitHub takes at most 65,536 characters in a summary.";
  if (event === "requestChanges" && words === "blank")
    return "Request changes needs a summary, as GitHub requires.";
  if (event === "comment" && comments === 0 && words === "blank")
    return "Write a summary or a comment on lines first.";
  return null;
}

/** The one write that sends the review: the summary and every pending
 * comment written against the head GitHub has. */
export function reviewOf(
  { id, head }: Pick<PullRequest, "id" | "head">,
  event: ReviewEvent,
  summary: string,
  current: readonly Pending[],
): Extract<PullWrite, { kind: "submitReview" }> {
  return {
    kind: "submitReview",
    pull: id,
    commit: head.oid,
    event,
    body: draftText(summary) === "takes" ? summary : "",
    threads: current.map(({ anchor: { path, side, line, start }, text }) => ({
      lines: { path, side, line, start },
      body: text,
    })),
  };
}

/** What to look at before sending. None of it stops a review. */
export function remindersOf({
  files,
  viewed,
  threads,
}: {
  files: readonly RangeFile[];
  viewed: ReadonlySet<RangeFile>;
  threads: readonly ReviewThread[];
}) {
  return {
    notViewed: files.filter((file) => !viewed.has(file)).length,
    of: files.length,
    unresolved: threads.filter(({ resolved }) => !resolved),
  };
}

/** "Your thread on a.ts:11 is unresolved", with the line, so two threads of
 * one file read apart. */
export function unresolvedText(
  { path, line, originalLine, comments }: ReviewThread,
  viewer: string,
): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const at = line ?? originalLine;
  return `${whose(comments.items[0]?.by ?? null, viewer)} thread on ${at === null ? file : `${file}:${at}`} is unresolved`;
}
