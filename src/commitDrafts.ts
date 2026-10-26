import { useCallback, useSyncExternalStore } from "react";
import { emptyDraft, splitMessage } from "./domain/commitMessage";
import type { Draft, Loaded } from "./domain/commitMessage";
import type { RepositoryRoot } from "./domain/repository";

export type CommitDraft = {
  draft: Draft;
  amend: { draftAside: Draft; loaded: Loaded } | null;
};

const blank: CommitDraft = { draft: emptyDraft, amend: null };
const drafts = new Map<RepositoryRoot, CommitDraft>();
const listeners = new Set<() => void>();

function set(root: RepositoryRoot, next: CommitDraft) {
  if (
    next.amend === null &&
    next.draft.summary === "" &&
    next.draft.description === ""
  )
    drafts.delete(root);
  else drafts.set(root, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCommitDraft(root: RepositoryRoot) {
  const current = useSyncExternalStore(
    subscribe,
    () => drafts.get(root) ?? blank,
  );
  const update = useCallback((next: CommitDraft) => set(root, next), [root]);
  return [current, update] as const;
}

export function clearDraft(root: RepositoryRoot) {
  set(root, blank);
}

export function restoreUndone(root: RepositoryRoot, message: string) {
  if (drafts.has(root)) return;
  set(root, { draft: splitMessage(message), amend: null });
}
