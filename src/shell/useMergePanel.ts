import { useEffect, useState } from "react";
import type { ComponentProps } from "react";
import type { MergeControls } from "../components/MergeControls";
import type { ReplayPanel } from "../components/ReplayPanel";
import {
  draftImpact as currentDraftImpact,
  useDraftImpact,
} from "../draftProtection";
import type { MergeSelection } from "../domain/merge";
import { branchName } from "../domain/operations";
import type { SidebarRefActions } from "./useRefWrites";
import type {
  Branch,
  ReplayKind,
  ReplayOf,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import type { Selection } from "../domain/selection";
import type { WritesView } from "../useWrites";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { UserSelection } from "./navigation";
import type { OpenedRepository } from "./sync";
import type { ActiveWorktree } from "./useActiveWorktree";

/** History's commit-row entries for a cherry-pick or revert onto the active worktree. */
export type CommitReplay = {
  /** Null when the active worktree is on no branch. */
  branch: string | null;
  disabled: boolean;
  onReview: (of: ReplayOf) => void;
};

/**
 * Merging, cherry-picking, and reverting into the active worktree. The
 * palette's `dialogOpen` is these reviews' state; the keydown handler reads
 * open dialogs from the DOM instead.
 */
export type MergePanel = {
  /** Null with no snapshot. Rendered with `key={controls.root}`, so a new worktree remounts it. */
  controls: ComponentProps<typeof MergeControls> | null;
  /** Null with no snapshot. Keyed by `replay.root`, so a new worktree remounts it too. */
  replay: ComponentProps<typeof ReplayPanel> | null;
  sidebar: SidebarRefActions["merge"];
  commitReplay: CommitReplay;
  actions: ActionSlice<
    | "dialogOpen"
    | "merging"
    | "mergeAvailable"
    | "selectedMergeAvailable"
    | "replay",
    "mergeUpstream" | "mergeBranch" | "replay"
  >;
};

export function useMergePanel({
  snapshot,
  active,
  selectedBranch,
  selection,
  opened,
  writes,
  rereadChanges,
  selecting,
  openInspector,
}: {
  snapshot: RepositorySnapshot | null;
  active: ActiveWorktree;
  selectedBranch: Branch | null;
  selection: Selection | null;
  opened: OpenedRepository;
  writes: Pick<
    WritesView,
    "running" | "merge" | "write" | "abortReplay" | "dismiss"
  >;
  rereadChanges: () => void;
  /** The user selects the worktree, which clears the sidebar jump. */
  selecting: UserSelection;
  openInspector: () => void;
}): MergePanel {
  const [review, setReview] = useState<{
    root: RepositoryRoot;
    selection: MergeSelection;
  } | null>(null);
  const [replayReview, setReplayReview] = useState<{
    root: RepositoryRoot;
    of: ReplayOf;
  } | null>(null);
  const { root, mergeState } = active;
  useEffect(() => {
    setReview(null);
    setReplayReview(null);
  }, [root]);
  const head = snapshot?.worktrees.find(
    (worktree) => worktree.root === root,
  )?.head;
  const eligible =
    head?.kind === "attached" &&
    opened.repository?.overview.branches.some(
      (branch) =>
        String(branch.reference) === String(head.reference) &&
        branch.state.kind === "diverged",
    ) === true;
  const busy =
    writes.running !== null || opened.repository?.activity.kind !== "idle";
  const idle = !busy && mergeState?.kind === "idle";
  const canMerge = head?.kind === "attached" && idle;
  const replayBranch = head?.kind === "attached" ? branchName(head) : null;
  const available = eligible && canMerge;
  const selectedMergeAvailable = canMerge && selectedBranch !== null;
  const pinned = review?.root === root ? review : null;
  const pinnedReplay = replayReview?.root === root ? replayReview : null;
  function open(selection: MergeSelection) {
    if (root && canMerge) setReview({ root, selection });
  }
  function openReplay(of: ReplayOf) {
    if (root && idle) setReplayReview({ root, of });
  }
  const inspect = () => {
    if (root) selecting.select({ kind: "worktree", root });
    openInspector();
  };
  return {
    sidebar: snapshot
      ? {
          root: snapshot.root,
          disabled: !canMerge,
          onSelect: (branch) =>
            open({ kind: "branch", reference: branch.reference }),
        }
      : undefined,
    commitReplay: {
      branch: replayBranch,
      disabled: !idle,
      onReview: openReplay,
    },
    controls:
      root && snapshot
        ? {
            root,
            read: active.merge,
            refresh: rereadChanges,
            eligible,
            busy,
            review: pinned?.selection ?? null,
            onReview: () => open({ kind: "upstream" }),
            onCloseReview: () => setReview(null),
            run: (action) => writes.merge(root, action),
            onInspect: inspect,
          }
        : null,
    replay:
      root && snapshot
        ? {
            root,
            read: active.merge,
            busy,
            write: writes.write,
            abort: writes.abortReplay,
            dismiss: writes.dismiss,
            review: pinnedReplay?.of ?? null,
            onCloseReview: () => setReplayReview(null),
            onInspect: inspect,
          }
        : null,
    actions: defineSlice({
      context: {
        dialogOpen: pinned !== null || pinnedReplay !== null,
        merging: active.merging,
        mergeAvailable: available,
        selectedMergeAvailable,
        replay: idle ? { branch: replayBranch } : null,
      },
      commands: {
        mergeBranch: () => {
          if (selectedMergeAvailable && selectedBranch)
            open({ kind: "branch", reference: selectedBranch.reference });
        },
        mergeUpstream: () => {
          if (available) open({ kind: "upstream" });
        },
        replay: (kind: ReplayKind) => {
          if (selection?.kind === "commit")
            openReplay({ kind, commit: selection.oid });
        },
      },
    }),
  };
}

/**
 * Unsaved conflict results across repositories, and the one reopened in
 * RetainedResolution. App subscribes to the draft impact, so it re-renders on
 * every draft revision.
 */
export type ResolutionDrafts = {
  resolutions: readonly { root: RepositoryRoot; path: string }[];
  retained: { root: RepositoryRoot; path: string } | null;
  /** Closes the file, opens the result's repository unless the snapshot lists it, then shows the result. */
  openRetained: (root: RepositoryRoot, path: string) => void;
  closeRetained: () => void;
};

export function useResolutionDrafts({
  snapshot,
  closeFile,
  selectRepository,
}: {
  snapshot: RepositorySnapshot | null;
  closeFile: () => void;
  selectRepository: (root: RepositoryRoot) => Promise<unknown>;
}): ResolutionDrafts {
  const { resolutions } = useDraftImpact();
  const [retained, setRetained] = useState<{
    root: RepositoryRoot;
    path: string;
  } | null>(null);
  useEffect(() => {
    if (resolutions.length === 0) return;
    const protect = (event: BeforeUnloadEvent) => {
      if (currentDraftImpact().frozen) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [resolutions.length]);
  return {
    resolutions,
    retained,
    openRetained: (root, path) => {
      closeFile();
      void (
        snapshot?.root === root ||
        snapshot?.worktrees.some((worktree) => worktree.root === root)
          ? Promise.resolve()
          : selectRepository(root)
      ).then(() => setRetained({ root, path }));
    },
    closeRetained: () => setRetained(null),
  };
}
