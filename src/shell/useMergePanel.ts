import { useEffect, useState } from "react";
import type { ComponentProps } from "react";
import type { MergeControls } from "../components/MergeControls";
import type { ReplayPanel } from "../components/ReplayPanel";
import type { MergeSelection } from "../domain/merge";
import { worktreeHead } from "../domain/worktree";
import { pullTarget } from "../domain/overview";
import type { PullMode } from "../domain/overview";
import type { OverviewStore } from "../overview";
import { shortBranch } from "../domain/refs";
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
import { localBusyReason } from "./sync";
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
 * Pulling, merging, cherry-picking, and reverting into the active worktree. The
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
    | "replay"
    | "pull",
    | "mergeUpstream"
    | "mergeBranch"
    | "replay"
    | "pullFastForwardIfPossible"
    | "pullFastForwardOnly"
    | "pullRebase"
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
  pull,
}: {
  snapshot: RepositorySnapshot | null;
  active: ActiveWorktree;
  selectedBranch: Branch | null;
  selection: Selection | null;
  opened: OpenedRepository;
  pull: OverviewStore["pull"];
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
  const head = worktreeHead(snapshot?.worktrees, root);
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
  const replayBranch =
    head?.kind === "attached" ? shortBranch(head.reference) : null;
  const available = eligible && canMerge;
  const pullable = !opened.repository
    ? {
        kind: "unavailable" as const,
        reason: "Checking the current repository…",
      }
    : pullTarget(
        opened.repository.overview.branches.find(
          (branch) => root !== null && branch.checkedOutAt === root,
        ),
        localBusyReason(writes.running !== null, opened.repository) ??
          (!mergeState
            ? "Checking this worktree…"
            : mergeState.kind !== "idle"
              ? "Finish or abort the operation in progress in this worktree first."
              : null),
      );
  const selectedMergeAvailable = canMerge && selectedBranch !== null;
  const pinned = review?.root === root ? review : null;
  const pinnedReplay = replayReview?.root === root ? replayReview : null;
  function open(selection: MergeSelection) {
    if (root && canMerge) setReview({ root, selection });
  }
  function openReplay(of: ReplayOf) {
    if (root && idle) setReplayReview({ root, of });
  }
  function pullWith(mode: PullMode) {
    const commonDir = opened.repository?.commonDir;
    if (
      root === null ||
      !commonDir ||
      head?.kind !== "attached" ||
      pullable.kind !== "ready"
    )
      return;
    void pull(commonDir, root, pullable.branch, mode).then((handOff) => {
      // `open` checks `canMerge` from this render, which a ready pull implies.
      if (handOff?.kind === "merge") open({ kind: "upstream" });
      if (handOff?.kind === "rebase")
        void writes.write(root, {
          operation: {
            kind: "rebase",
            branch: head.reference,
            onto: handOff.onto,
          },
          expect: { head },
        });
    });
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
        pull: pullable,
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
        pullFastForwardIfPossible: () => pullWith("ffIfPossible"),
        pullFastForwardOnly: () => pullWith("ffOnly"),
        pullRebase: () => pullWith("rebase"),
      },
    }),
  };
}
