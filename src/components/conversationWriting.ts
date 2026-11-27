import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { Anchor } from "../domain/drafts";
import type { PullRequest, ReviewThread } from "../domain/pullRequest";
import type { PullWrite } from "../domain/pullRequestWrites";
import type { Oid } from "../domain/repository";
import type { Attempt } from "../pullRequestWrites";
import type { usePullWrites } from "../shell/usePullWriting";
import type { OpenedPullRequest } from "../shell/usePullRequests";

/** What the conversation's boxes and buttons need to write to GitHub. */
export type ConversationWriting = {
  opened: Parameters<typeof usePullWrites>[0];
  pull: PullRequest["id"];
  head: Oid;
  url: string;
};

/** Null where nothing writes. */
export const ConversationWritingContext =
  createContext<ConversationWriting | null>(null);

/** The same object while what it holds stays, for the conversation and for
 * the threads in Files changed. */
export function useConversationWriting(
  {
    writing,
    viewer,
    repository: { github },
    number,
  }: Pick<OpenedPullRequest, "writing" | "viewer" | "repository" | "number">,
  { id, head }: PullRequest,
  url: string,
): ConversationWriting {
  return useMemo(
    () => ({
      opened: { writing, viewer, repository: { github }, number },
      pull: id,
      head: head.oid,
      url,
    }),
    [writing, viewer, github, number, id, head.oid, url],
  );
}

/** Where a write shows: the conversation's box, a thread's reply box, or a
 * thread's Resolve button. */
export type WritePlace =
  | { kind: "comment" }
  | { kind: "reply"; thread: string }
  | { kind: "resolve"; thread: string };

function isAt(write: PullWrite, place: WritePlace): boolean {
  switch (place.kind) {
    case "comment":
      return write.kind === "comment";
    case "reply":
      return write.kind === "reply" && write.thread === place.thread;
    case "resolve":
      return (
        (write.kind === "resolve" || write.kind === "unresolve") &&
        write.thread === place.thread
      );
  }
}

/** A thread's comments a read holds, as detail.graphql asks for them. */
const COMMENTS_READ = 50;

/** Whether the next read of a thread shows a reply posted to it now. */
export const readShowsReply = ({ items, total }: ReviewThread["comments"]) =>
  items.length === total && total < COMMENTS_READ;

const quiet = () => () => {};

/** Whether a reply or a resolve of `thread` is sending, or ended in a way
 * the thread has to show, so it stays open. */
export function useThreadWaits(thread: string): boolean {
  const writing = use(ConversationWritingContext);
  const writes = writing?.opened.writing.writes;
  const github = writing?.opened.repository.github;
  const number = writing?.opened.number;
  return useSyncExternalStore(writes?.subscribe ?? quiet, () =>
    writes && github && number !== undefined
      ? writes
          .attempts({ repository: github, number })
          .some(
            ({ write, state }) =>
              state.kind !== "done" &&
              (isAt(write, { kind: "reply", thread }) ||
                isAt(write, { kind: "resolve", thread })),
          )
      : false,
  );
}

/** The newest write at `place` that hasn't posted: it is sending, or it
 * ended in a way the place has to show. */
export const waitingAt = (attempts: readonly Attempt[], place: WritePlace) =>
  attempts.findLast(
    ({ write, state }) => isAt(write, place) && state.kind !== "done",
  ) ?? null;

/** The writes at `place` that GitHub did, whose words show from here until
 * a read has them. */
export const doneAt = (attempts: readonly Attempt[], place: WritePlace) =>
  attempts.filter(
    ({ write, state }) => isAt(write, place) && state.kind === "done",
  );

export const anchorOf = (
  place: Extract<WritePlace, { kind: "comment" | "reply" }>,
): Anchor =>
  place.kind === "comment"
    ? { kind: "conversation" }
    : { kind: "reply", thread: place.thread };

/** The words of a comment or a reply. */
export const wordsOf = (write: PullWrite) =>
  write.kind === "comment" || write.kind === "reply" ? write.body : "";

/** The id GitHub gave a done comment or reply. */
export const madeId = ({ state }: Attempt) =>
  state.kind === "done" && state.echo.kind === "comment" ? state.echo.id : null;

/** How long a place says that its write posted, at least. */
const SAYS_MS = 8_000;

/**
 * What to say of the last write that posted at a place: its `text` from when
 * a new one comes until 8 seconds later, or until `quiet`, as the user moves
 * on. The read right after it posted drops the write within moments.
 */
export function useLasting(note: { id: string; text: string } | null) {
  const [told, setTold] = useState<{ id: string; text: string | null } | null>(
    null,
  );
  if (note !== null && note.id !== told?.id) setTold(note);
  useEffect(() => {
    if (told?.text == null) return;
    const timer = setTimeout(
      () => setTold((was) => was && { ...was, text: null }),
      SAYS_MS,
    );
    return () => clearTimeout(timer);
  }, [told]);
  return {
    text: told?.text ?? null,
    quiet: () => setTold((was) => was && { ...was, text: null }),
  };
}
