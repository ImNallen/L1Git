import { useEffect, useState } from "react";
import { mergeAllows } from "../domain/merge";
import type { MergeState } from "../domain/merge";
import type {
  Operation,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import type { Selection } from "../domain/selection";
import type { ChangesByWorktree } from "../domain/worktree";
import { useMergeState } from "../useMergeState";
import type { Read } from "../useRead";

/**
 * The worktree that merge, undo history, partial staging, and the
 * inspector's merge gating act on: the linked worktree last selected in the
 * open repository while the snapshot still lists it, else the repository
 * root, null with no snapshot. Selecting a commit keeps it; switching
 * repository resets it.
 */
export type ActiveWorktree = {
  root: RepositoryRoot | null;
  /** Rereads whenever `changes.get(root)` changes identity. */
  merge: Read<MergeState>;
  mergeState: MergeState | null;
  merging: boolean;
  refreshMerge: () => void;
  /** This worktree's merge state for `root`, null for any other worktree. */
  mergeStateFor: (root: RepositoryRoot | undefined) => MergeState | null;
  /** A merge runs on `root`, and `root` is this worktree. */
  mergingIn: (root: RepositoryRoot | null) => boolean;
  /** False only when `root` is this worktree and its merge forbids `operation`. */
  allows: (root: RepositoryRoot, operation: Operation) => boolean;
};

export function useActiveWorktree(
  snapshot: RepositorySnapshot | null,
  selection: Selection | null,
  changes: ChangesByWorktree,
): ActiveWorktree {
  const [target, setTarget] = useState<{
    openedRoot: RepositoryRoot;
    target: RepositoryRoot;
  } | null>(null);
  const root =
    target !== null &&
    target.openedRoot === snapshot?.root &&
    snapshot?.worktrees.some((worktree) => worktree.root === target.target)
      ? target.target
      : (snapshot?.root ?? null);
  const [merge, refreshMerge] = useMergeState(
    root,
    root === null ? undefined : changes.get(root),
  );
  const mergeState = merge.kind === "ready" ? merge.value : null;
  const merging = mergeState !== null && mergeState.kind !== "idle";
  // The reset must run before the set, or a worktree selection restored with the repository is wiped.
  useEffect(() => {
    setTarget(null);
  }, [snapshot?.root]);
  useEffect(() => {
    if (selection?.kind === "worktree" && snapshot?.root)
      setTarget({ openedRoot: snapshot.root, target: selection.root });
  }, [selection, snapshot?.root]);
  return {
    root,
    merge,
    mergeState,
    merging,
    refreshMerge,
    mergeStateFor: (candidate) => (candidate === root ? mergeState : null),
    mergingIn: (candidate) => root !== null && candidate === root && merging,
    allows: (candidate, operation) =>
      candidate !== root || mergeAllows(mergeState, operation),
  };
}
