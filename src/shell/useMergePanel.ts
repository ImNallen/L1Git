import { useEffect, useState } from "react";
import type { ComponentProps } from "react";
import type { MergeControls } from "../components/MergeControls";
import {
  draftImpact as currentDraftImpact,
  useDraftImpact,
} from "../draftProtection";
import type { MergeSelection } from "../domain/merge";
import type { SidebarRefActions } from "./useRefWrites";
import type {
  Branch,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import type { WritesView } from "../useWrites";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { UserSelection } from "./navigation";
import type { OpenedRepository } from "./sync";
import type { ActiveWorktree } from "./useActiveWorktree";

/**
 * Merging into the active worktree. The palette's `dialogOpen` is this
 * review's state; the keydown handler reads open dialogs from the DOM instead.
 */
export type MergePanel = {
  /** Null with no snapshot. Rendered with `key={controls.root}`, so a new worktree remounts it. */
  controls: ComponentProps<typeof MergeControls> | null;
  sidebar: SidebarRefActions["merge"];
  actions: ActionSlice<
    "dialogOpen" | "merging" | "mergeAvailable" | "selectedMergeAvailable",
    "mergeUpstream" | "mergeBranch"
  >;
};

export function useMergePanel({
  snapshot,
  active,
  selectedBranch,
  opened,
  writes,
  rereadChanges,
  selecting,
  openInspector,
}: {
  snapshot: RepositorySnapshot | null;
  active: ActiveWorktree;
  selectedBranch: Branch | null;
  opened: OpenedRepository;
  writes: Pick<WritesView, "running" | "merge">;
  rereadChanges: () => void;
  /** The user selects the worktree, which clears the sidebar jump. */
  selecting: UserSelection;
  openInspector: () => void;
}): MergePanel {
  const [review, setReview] = useState<{
    root: RepositoryRoot;
    selection: MergeSelection;
  } | null>(null);
  const { root, mergeState } = active;
  useEffect(() => {
    setReview(null);
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
  const canMerge =
    head?.kind === "attached" && !busy && mergeState?.kind === "idle";
  const available = eligible && canMerge;
  const selectedMergeAvailable = canMerge && selectedBranch !== null;
  const pinned = review?.root === root ? review : null;
  function open(selection: MergeSelection) {
    if (root && canMerge) setReview({ root, selection });
  }
  return {
    sidebar: snapshot
      ? {
          root: snapshot.root,
          disabled: !canMerge,
          onSelect: (branch) =>
            open({ kind: "branch", reference: branch.reference }),
        }
      : undefined,
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
            onInspect: () => {
              selecting.select({ kind: "worktree", root });
              openInspector();
            },
          }
        : null,
    actions: defineSlice({
      context: {
        dialogOpen: pinned !== null,
        merging: active.merging,
        mergeAvailable: available,
        selectedMergeAvailable,
      },
      commands: {
        mergeBranch: () => {
          if (selectedMergeAvailable && selectedBranch)
            open({ kind: "branch", reference: selectedBranch.reference });
        },
        mergeUpstream: () => {
          if (available) open({ kind: "upstream" });
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
