import { createContext, useMemo, useState } from "react";
import { draftKey, draftText } from "../domain/drafts";
import type { DraftKey } from "../domain/drafts";
import { carriedBy } from "../domain/lineComments";
import type { LineAnchor, Lines } from "../domain/lineComments";
import type { PullRequest } from "../domain/pullRequest";
import type { PullWrite } from "../domain/pullRequestWrites";
import type { Oid } from "../domain/repository";
import type { Notes } from "../domain/reviewThreads";
import type { RangeFile } from "../domain/range";
import type { Attempt } from "../pullRequestWrites";
import { usePullDrafts, usePullWrites } from "../shell/usePullWriting";
import { sentNothing } from "./sentNothing";
import type { OpenedPullRequest } from "../shell/usePullRequests";

type Opened = Pick<
  OpenedPullRequest,
  "writing" | "viewer" | "repository" | "number"
>;
export type ShownDraft = ReturnType<typeof usePullDrafts>["drafts"][number];
export type DraftSave = ShownDraft["save"];

/** Where the box sends from: nowhere yet, saving its words before it sends,
 * or one attempt whose outcome shows in the box. */
type Sending =
  | { kind: "idle"; problem: string | null }
  /** Saving its words, until the writes store holds `write`. */
  | { kind: "starting"; write: PullWrite }
  | { kind: "sent"; attempt: string };

/** The one comment box. Its words are the draft at its place, never here. */
type Box = {
  anchor: LineAnchor;
  head: Oid;
  /** The words of the pending comment it edits, which Cancel puts back. Null
   * for a new comment. */
  before: string | null;
  sending: Sending;
};

/** What the box shows, from its draft and its attempt. */
export type BoxView =
  | {
      kind: "writing";
      text: string;
      /** Null before the first word. */
      save: DraftSave | null;
      mayHavePosted: boolean;
      problem: string | null;
    }
  /** Read-only: the host holds its words until GitHub answers. */
  | { kind: "sending"; text: string }
  /** Read-only: another write, such as a review or another window's
   * comment, carries the words saved here until it ends. */
  | { kind: "held"; text: string; isSending: boolean }
  | { kind: "unknown"; text: string; attempt: Attempt };

const idle: Sending = { kind: "idle", problem: null };

const linesOf = ({ path, side, line, start }: LineAnchor): Lines => ({
  path,
  side,
  line,
  start,
});

const isLine = (
  draft: ShownDraft,
): draft is ShownDraft & { anchor: LineAnchor } => draft.anchor.kind === "line";

/** The words a write carries for the draft at `key`. */
function wordsAt(write: PullWrite, key: DraftKey): string {
  if (write.kind === "singleComment") return write.body;
  if (write.kind !== "submitReview") return "";
  const thread = write.threads.find(
    ({ lines }) => draftKey({ kind: "line", ...lines }, write.commit) === key,
  );
  return thread?.body ?? "";
}

const sentLines = (attempt: Attempt) =>
  attempt.write.kind === "singleComment" ? attempt.write : null;

/**
 * Comments on the lines of the head shown: the pending ones, the single ones
 * sent, and the one box. Pending comments are drafts on this computer; a
 * single comment posts on its own click.
 */
export function useLineComments({
  opened,
  head,
  pull,
}: {
  opened: Opened;
  /** The head of what is shown. */
  head: Oid;
  /** The newest read. */
  pull: PullRequest;
}) {
  const drafts = usePullDrafts(opened);
  const writes = usePullWrites(opened);
  const [held, setBox] = useState<Box | null>(null);
  /** Why chosen lines opened no box. */
  const [notice, setNotice] = useState<string | null>(null);
  const box = held?.head === head ? held : null;
  const lineDrafts = useMemo(() => {
    const carried = new Set(
      writes.attempts.flatMap(({ write, state }) =>
        state.kind === "sending" ? carriedBy(write) : [],
      ),
    );
    return drafts.drafts.filter(
      (draft): draft is ShownDraft & { anchor: LineAnchor } =>
        isLine(draft) && !carried.has(draft.key),
    );
  }, [drafts, writes.attempts]);
  const sent = useMemo(
    () => writes.attempts.filter((attempt) => sentLines(attempt) !== null),
    [writes.attempts],
  );
  const draftAt = (anchor: LineAnchor, at: Oid) => {
    const key = draftKey(anchor, at);
    return lineDrafts.find((draft) => draft.key === key) ?? null;
  };
  const sending = box?.sending;
  // From the moment the store holds it, so its line never shows it twice.
  const boxAttempt =
    sending?.kind === "sent"
      ? (writes.attempts.find(({ id }) => id === sending.attempt) ?? null)
      : sending?.kind === "starting"
        ? (writes.attempts.findLast(({ write }) => write === sending.write) ??
          null)
        : null;
  // A single comment GitHub has is shown on its line until a read has it.
  if (box && boxAttempt?.state.kind === "done") setBox(null);

  const view = ((): BoxView | null => {
    if (!box) return null;
    const { sending } = box;
    if (sending.kind === "starting" && !boxAttempt)
      return { kind: "sending", text: draftAt(box.anchor, head)?.text ?? "" };
    const state = boxAttempt?.state;
    const body =
      boxAttempt?.write.kind === "singleComment" ? boxAttempt.write.body : "";
    if (state?.kind === "sending") return { kind: "sending", text: body };
    if (state?.kind === "unknown" && boxAttempt)
      return { kind: "unknown", text: body, attempt: boxAttempt };
    if (drafts.held(box.anchor, head)) {
      const key = draftKey(box.anchor, head);
      const holder = writes.attempts.find(
        ({ write, state }) =>
          (state.kind === "sending" || state.kind === "unknown") &&
          carriedBy(write).includes(key),
      );
      return {
        kind: "held",
        text: holder ? wordsAt(holder.write, key) : "",
        isSending: holder?.state.kind !== "unknown",
      };
    }
    const draft = draftAt(box.anchor, head);
    return {
      kind: "writing",
      text: draft?.text ?? "",
      save: draft?.save ?? null,
      mayHavePosted: draft?.mayHavePosted ?? false,
      problem:
        state?.kind === "refused" || state?.kind === "notSent"
          ? state.message
          : sending.kind === "idle"
            ? sending.problem
            : null,
    };
  })();

  const places = JSON.stringify([
    lineDrafts.map(({ key, anchor, head: at }) => [key, anchor, at]),
    sent.map(({ id, write }) => [id, write]),
    box && [box.anchor, boxAttempt?.id ?? null],
  ]);
  /** Ids and places only, the same object while they stay, so typing draws
   * no line again. */
  const notesOf = useMemo(() => {
    const [draftPlaces, sentPlaces, boxPlace] = JSON.parse(places) as [
      [DraftKey, LineAnchor, Oid][],
      [string, Extract<PullWrite, { kind: "singleComment" }>][],
      [LineAnchor, string | null] | null,
    ];
    const cache = new Map<string, Omit<Notes, "threads">>();
    return (file: RangeFile): Omit<Notes, "threads"> => {
      const paths = [file.path, file.from];
      const known = cache.get(file.path);
      if (known) return known;
      const made = {
        drafts: draftPlaces
          .filter(([, anchor]) => paths.includes(anchor.path))
          .map(([key, anchor, at]) => ({ key, anchor, head: at })),
        sent: sentPlaces
          .filter(([, write]) => paths.includes(write.lines.path))
          .map(([id, write]) => ({
            id,
            lines: write.lines,
            commit: write.commit,
          })),
        box:
          boxPlace && boxPlace[0].path === file.path
            ? { anchor: boxPlace[0], attempt: boxPlace[1] }
            : null,
      };
      cache.set(file.path, made);
      return made;
    };
  }, [places]);

  const text = view?.kind === "writing" ? view.text : "";
  const change = (next: Partial<Box>) =>
    setBox((before) => before && { ...before, ...next });

  async function single() {
    if (!box || view?.kind !== "writing") return;
    if (draftText(text) !== "takes") return;
    const { anchor } = box;
    const write: PullWrite = {
      kind: "singleComment",
      pull: pull.id,
      commit: head,
      lines: linesOf(anchor),
      body: text,
    };
    change({ sending: { kind: "starting", write } });
    const started = await writes.send(write, [{ anchor, head }]);
    const attempt = opened.writing.writes
      .attempts({ repository: opened.repository.github, number: opened.number })
      .findLast((each) => each.write === write);
    change({
      sending:
        started === "started" && attempt
          ? { kind: "sent", attempt: attempt.id }
          : {
              kind: "idle",
              problem: started === "started" ? null : sentNothing[started],
            },
    });
  }

  return {
    head,
    /** The head GitHub has: a review goes with that one. */
    isBehind: pull.head.oid !== head,
    drafts: lineDrafts,
    sent,
    box: box &&
      view && { anchor: box.anchor, isEdit: box.before !== null, view },
    /** Whether a review has begun: a pending comment besides the box's own. */
    hasReview: lineDrafts.some(
      (draft) =>
        draft.head === head &&
        (!box || draft.key !== draftKey(box.anchor, head)),
    ),
    notesOf,
    notice,
    dismissNotice: () => setNotice(null),
    refuseLines: () =>
      setNotice(
        "GitHub takes comments only on the lines of a change. Choose lines inside a hunk.",
      ),
    /** Opens the box on lines, on the pending comment there if one is. */
    open(anchor: LineAnchor) {
      setNotice(null);
      if (box && draftKey(box.anchor, head) === draftKey(anchor, head)) return;
      setBox({
        anchor,
        head,
        before: draftAt(anchor, head)?.text ?? null,
        sending: idle,
      });
    },
    type(words: string) {
      if (box && view?.kind === "writing") drafts.type(box.anchor, head, words);
    },
    /** Puts back the words an Edit began with, or deletes a new comment.
     * While a send holds the words, it only closes the box. */
    cancel() {
      if (!box) return;
      if (view?.kind !== "writing") return setBox(null);
      if (boxAttempt) writes.dismiss(boxAttempt.id);
      if (box.before !== null) {
        drafts.type(box.anchor, head, box.before);
        void drafts.flush();
      } else if (draftAt(box.anchor, head))
        void drafts.remove(box.anchor, head);
      setBox(null);
    },
    /** Start a review: the words stay here as a pending comment. */
    keep() {
      if (!box) return;
      if (boxAttempt) writes.dismiss(boxAttempt.id);
      void drafts.flush();
      setBox(null);
    },
    single,
    clearProblem() {
      if (boxAttempt) writes.dismiss(boxAttempt.id);
      change({ sending: idle });
    },
    /** Ends "changed in another window" for the box's words. */
    settleBox(pick: "mine" | "theirs") {
      if (box) drafts.settle(draftKey(box.anchor, head), pick);
    },
    keepAsDraft: async (attempt: string) => {
      const kept = await writes.keep(attempt);
      if (kept)
        setBox((before) =>
          before?.sending.kind === "sent" && before.sending.attempt === attempt
            ? { ...before, sending: idle }
            : before,
        );
      return kept;
    },
    sendAnyway: (attempt: string) => writes.sendAnyway(attempt),
    dismiss: (attempt: string) => writes.dismiss(attempt),
    remove: (draft: ShownDraft) => void drafts.remove(draft.anchor, draft.head),
  };
}

export type LineComments = ReturnType<typeof useLineComments>;

export const noNotes: Omit<Notes, "threads"> = {
  drafts: [],
  sent: [],
  box: null,
};

export const LineCommentsContext = createContext<LineComments | null>(null);
