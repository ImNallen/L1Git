import { createContext } from "react";
import type { Anchor } from "../domain/drafts";
import type { PullRequest } from "../domain/pullRequest";
import type { PullWrite } from "../domain/pullRequestWrites";
import type { Oid } from "../domain/repository";
import type { Attempt } from "../pullRequestWrites";
import type { usePullWrites } from "../shell/usePullWriting";

/** What the conversation's boxes and buttons need to write to GitHub. */
export type ConversationWriting = {
  opened: Parameters<typeof usePullWrites>[0];
  pull: PullRequest["id"];
  head: Oid;
  url: string;
};

/** Null where nothing writes, as in Files changed. */
export const ConversationWritingContext =
  createContext<ConversationWriting | null>(null);

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
