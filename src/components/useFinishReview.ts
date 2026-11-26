import { useState } from "react";
import { draftKey, draftText } from "../domain/drafts";
import type { Anchor } from "../domain/drafts";
import { byHead, eventsFor, heldBack, reviewOf } from "../domain/finishReview";
import type { ReviewEvent } from "../domain/finishReview";
import type { Lines } from "../domain/lineComments";
import type { PullRequest } from "../domain/pullRequest";
import type { PullWrite } from "../domain/pullRequestWrites";
import type { Attempt } from "../pullRequestWrites";
import { usePullDrafts, usePullWrites } from "../shell/usePullWriting";
import type { OpenedPullRequest } from "../shell/usePullRequests";
import type { LineComments } from "./useLineComments";

type Opened = Pick<
  OpenedPullRequest,
  "writing" | "viewer" | "repository" | "number"
>;

/** Nothing sent yet, saving the drafts before it sends, or one attempt. */
type Sending =
  | { kind: "idle"; problem: string | null }
  | { kind: "starting" }
  | { kind: "sent"; attempt: string };

/** How the last send of the popover stands. */
type SendView =
  | { kind: "idle"; problem: string | null }
  | { kind: "sending" }
  | { kind: "unknown"; attempt: Attempt };

const idle: Sending = { kind: "idle", problem: null };

type Listed = {
  key: string;
  lines: Lines;
  text: string;
  mayHavePosted: boolean;
};
const summaryAnchor: Anchor = { kind: "summary" };
const sendProblems = {
  busy: "Another write to this pull request is still sending, or may have posted. L1 Git sends nothing more for it until it knows.",
  unsaved:
    "L1 Git couldn't save your words on this computer, so it sent nothing.",
  signedOut: "L1 Git isn't signed in to GitHub, so it sent nothing.",
  restarting: "L1 Git is restarting to update, so it sent nothing.",
  notInRead:
    "L1 Git's latest read of this pull request doesn't match this review, so it sent nothing. Refresh the pull request and try again.",
} as const;

const isReview = ({ write }: Attempt) =>
  write.kind === "submitReview" || write.kind === "submitPending";

/**
 * Finish review: one write with the summary and every pending comment
 * written against the head GitHub has, or, while you have a review in
 * progress on github.com, that one as it is.
 */
export function useFinishReview({
  opened,
  pull,
  comments,
}: {
  opened: Opened;
  /** The newest read. */
  pull: PullRequest;
  comments: LineComments;
}) {
  const drafts = usePullDrafts(opened);
  const writes = usePullWrites(opened);
  const [isOpen, setOpen] = useState(false);
  const [chosen, choose] = useState<ReviewEvent>("comment");
  const [sending, setSending] = useState<Sending>(idle);
  const head = pull.head.oid;
  // A new comment still in its box is not in the review until Start a review.
  const writing =
    comments.box && !comments.box.isEdit
      ? draftKey(comments.box.anchor, comments.head)
      : null;
  const { current, older } = byHead(
    comments.drafts.filter(({ key }) => key !== writing),
    head,
  );
  const summaryDraft =
    drafts.drafts.find(({ anchor }) => anchor.kind === "summary") ?? null;
  const summary = summaryDraft?.text ?? "";
  const events = eventsFor(pull);
  const event = events.includes(chosen) ? chosen : "comment";
  const attempt =
    sending.kind === "sent"
      ? (writes.attempts.find(({ id }) => id === sending.attempt) ?? null)
      : null;
  if (attempt?.state.kind === "done") {
    setSending(idle);
    setOpen(false);
  }
  const done = writes.attempts.some(
    (each) => isReview(each) && each.state.kind === "done",
  );
  const unknown = writes.attempts.some(
    (each) => isReview(each) && each.state.kind === "unknown",
  );
  const state = attempt?.state;
  /** What the popover lists: the comments its review carries while that is
   * out or may have posted, else the pending ones that would send. */
  const listed: readonly Listed[] =
    attempt?.write.kind === "submitReview" &&
    (state?.kind === "sending" || state?.kind === "unknown")
      ? attempt.write.threads.map(({ lines, body }, index) => ({
          key: `${attempt.id} ${index}`,
          lines,
          text: body,
          mayHavePosted: false,
        }))
      : current.map(({ key, anchor, text, mayHavePosted }) => ({
          key,
          lines: anchor,
          text,
          mayHavePosted,
        }));
  const send: SendView =
    sending.kind === "starting" || state?.kind === "sending"
      ? { kind: "sending" }
      : state?.kind === "unknown" && attempt
        ? { kind: "unknown", attempt }
        : {
            kind: "idle",
            problem:
              state?.kind === "refused" || state?.kind === "notSent"
                ? state.message
                : sending.kind === "idle"
                  ? sending.problem
                  : null,
          };
  const pending = pull.pending.kind === "review" ? pull.pending : null;
  const reason = pending
    ? heldBack({ event, summary, comments: pending.comments.total })
    : heldBack({ event, summary, comments: current.length });

  async function submit() {
    if (send.kind !== "idle" || reason !== null) return;
    const write: PullWrite = pending
      ? { kind: "submitPending", review: pending.id, event, body: summary }
      : reviewOf(pull, event, summary, current);
    const carried = [
      ...(pending
        ? []
        : current.map(({ anchor, head: at }) => ({ anchor, head: at }))),
      ...(summaryDraft && draftText(summary) === "takes"
        ? [{ anchor: summaryAnchor, head: summaryDraft.head }]
        : []),
    ];
    if (attempt) writes.dismiss(attempt.id);
    setSending({ kind: "starting" });
    const started = await writes.send(write, carried);
    const made = opened.writing.writes
      .attempts({ repository: opened.repository.github, number: opened.number })
      .findLast((each) => each.write === write);
    setSending(
      started === "started" && made
        ? { kind: "sent", attempt: made.id }
        : {
            kind: "idle",
            problem: started === "started" ? null : sendProblems[started],
          },
    );
  }

  return {
    isOpen,
    open: () => setOpen(true),
    close: () => {
      if (send.kind === "sending") return;
      void drafts.flush();
      setOpen(false);
    },
    /** Pending comments that send, counted on the button. */
    current,
    listed,
    older,
    pending,
    events,
    event,
    choose,
    summary,
    typeSummary: (text: string) => {
      if (send.kind === "idle") drafts.type(summaryAnchor, head, text);
    },
    summarySave: summaryDraft?.save ?? null,
    reason,
    send,
    done,
    unknown,
    submit,
    clearProblem: () => {
      if (attempt) writes.dismiss(attempt.id);
      setSending(idle);
    },
    keepAsDraft: async (id: string) => {
      const kept = await writes.keep(id);
      if (kept) setSending(idle);
      return kept;
    },
    sendAnyway: (id: string) => writes.sendAnyway(id),
    dismiss: (id: string) => {
      writes.dismiss(id);
      setSending(idle);
    },
  };
}

export type FinishReview = ReturnType<typeof useFinishReview>;
