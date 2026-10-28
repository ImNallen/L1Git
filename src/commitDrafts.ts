import { useCallback, useSyncExternalStore } from "react";
import { emptyDraft, splitMessage } from "./domain/commitMessage";
import type { Draft, Loaded } from "./domain/commitMessage";
import type { Head, Oid, RepositoryRoot } from "./domain/repository";

export type CommitDraft = {
  draft: Draft;
  amend: { draftAside: Draft; loaded: Loaded; head: Oid } | null;
};

const blank: CommitDraft = { draft: emptyDraft, amend: null };
const drafts = new Map<RepositoryRoot, CommitDraft>();
const listeners = new Set<() => void>();

const isBlank = ({ draft, amend }: CommitDraft) =>
  amend === null && draft.summary === "" && draft.description === "";

export function setDraft(root: RepositoryRoot, next: CommitDraft) {
  if (isBlank(next)) drafts.delete(root);
  else drafts.set(root, next);
  for (const listener of listeners) listener();
}

export const draftOf = (root: RepositoryRoot): CommitDraft =>
  drafts.get(root) ?? blank;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCommitDraft(root: RepositoryRoot) {
  const read = () => draftOf(root);
  const current = useSyncExternalStore(subscribe, read, read);
  const update = useCallback(
    (next: CommitDraft) => setDraft(root, next),
    [root],
  );
  return [current, update] as const;
}

/** A commit clears the draft it sent, but keeps edits typed while it ran. */
export function clearSubmitted(root: RepositoryRoot, sent: CommitDraft) {
  if (draftOf(root) === sent) setDraft(root, blank);
}

/** An amend's message belongs to the commit it was loaded from. */
export const amendsHead = (draft: CommitDraft, head: Head) =>
  draft.amend !== null &&
  head.kind !== "unborn" &&
  head.oid === draft.amend.head;

export function restoreUndone(root: RepositoryRoot, message: string) {
  if (!isBlank(draftOf(root))) return;
  setDraft(root, { draft: splitMessage(message), amend: null });
}
