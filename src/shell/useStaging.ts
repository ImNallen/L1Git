import { useMemo, useState } from "react";
import type { WorktreeWrites } from "../components/CommitInspector";
import type { Compare } from "../domain/comparison";
import { discardChoice, writeFor } from "../domain/operations";
import type { FileWrite, Write } from "../domain/operations";
import type {
  Head,
  RepositoryRoot,
  RepositorySnapshot,
  Worktree,
} from "../domain/repository";
import type { Selection } from "../domain/selection";
import { listWrites, worktreeGroups } from "../domain/worktree";
import type { ChangesByWorktree, WorktreeChanges } from "../domain/worktree";
import { canMark, resolutionKey, resolutionOf } from "../resolutionDrafts";
import type { WritesView } from "../useWrites";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { ActiveWorktree } from "./useActiveWorktree";
import type { Focus } from "./useFocus";

export type SelectedWorktree = {
  worktree: Worktree;
  changes: WorktreeChanges | undefined;
};

export type Discarding = {
  root: RepositoryRoot;
  write: Write;
  paths: string[];
  skipped: number;
  returnFocus?: () => void;
};

export type Stashing = {
  root: RepositoryRoot;
  paths: string[];
  untracked: boolean;
  head: Head;
};

/**
 * Stage, unstage, discard, and stash on the selected worktree. `inspectorWrites.write`
 * is the inspector's only path to file writes, and it refuses staging an
 * unmarkable resolution draft and anything the active worktree's merge forbids.
 */
export type Staging = {
  selectedWorktree: SelectedWorktree | null;
  inspectorWrites: WorktreeWrites;
  discarding: Discarding | null;
  closeDiscard: () => void;
  stashing: Stashing | null;
  closeStash: () => void;
  actions: ActionSlice<
    "worktree",
    "stageAll" | "unstageAll" | "discardAll" | "stashChanges"
  >;
};

export function useStaging({
  snapshot,
  selection,
  compare,
  changes,
  writes,
  active,
  focus,
}: {
  snapshot: RepositorySnapshot | null;
  selection: Selection | null;
  compare: Compare | null;
  changes: ChangesByWorktree;
  writes: Pick<WritesView, "running" | "write">;
  active: Pick<ActiveWorktree, "allows" | "mergeStateFor">;
  focus: Pick<Focus, "checkLost">;
}): Staging {
  const [discarding, setDiscarding] = useState<Discarding | null>(null);
  const [stashing, setStashing] = useState<Stashing | null>(null);
  const listedWorktree =
    selection?.kind === "worktree"
      ? snapshot?.worktrees.find((worktree) => worktree.root === selection.root)
      : undefined;
  const selectedWorktree = listedWorktree
    ? {
        worktree: listedWorktree,
        changes: changes.get(listedWorktree.root),
      }
    : null;
  function writeFiles(
    root: RepositoryRoot,
    kind: FileWrite,
    paths: readonly string[],
  ) {
    if (
      kind === "stageFiles" &&
      paths.some((path) => {
        const draft = resolutionOf(resolutionKey(root, path));
        return draft !== null && !canMark(draft);
      })
    )
      return Promise.resolve(false);
    const listed = changes.get(root);
    const write =
      listed?.kind === "ready" ? writeFor(kind, listed.status, paths) : null;
    return write === null || !active.allows(root, write.operation)
      ? Promise.resolve(false)
      : writes.write(root, write);
  }
  function askDiscard(
    root: RepositoryRoot,
    paths: readonly string[],
    returnFocus?: () => void,
  ) {
    const listed = changes.get(root);
    if (listed?.kind !== "ready") return;
    const choice = discardChoice(listed.status, paths);
    const write = writeFor("discard", listed.status, choice.paths);
    if (write !== null) setDiscarding({ root, write, ...choice, returnFocus });
  }
  function askStash(root: RepositoryRoot, paths: readonly string[]) {
    const listed = changes.get(root);
    if (listed?.kind !== "ready") return;
    const named = new Set(paths);
    const untracked =
      paths.length > 0 &&
      listed.status.entries.some(
        (entry) =>
          entry.kind === "untracked" &&
          !entry.path.endsWith("/") &&
          named.has(entry.path),
      );
    setStashing({
      root,
      paths: [...paths],
      untracked,
      head: listed.status.head,
    });
  }
  const selectedChanges =
    compare === null ? selectedWorktree?.changes : undefined;
  const selectedLists = useMemo(
    () =>
      selectedChanges?.kind === "ready"
        ? new Map(
            worktreeGroups(selectedChanges.status.entries).map((group) => [
              group.side,
              group.files.map((file) => file.path),
            ]),
          )
        : null,
    [selectedChanges],
  );
  function writeList(side: "unstaged" | "staged") {
    const paths = selectedLists?.get(side);
    if (selectedWorktree && paths)
      void writeFiles(
        selectedWorktree.worktree.root,
        listWrites[side].kind,
        paths,
      );
  }
  return {
    selectedWorktree,
    inspectorWrites: {
      busy: writes.running !== null,
      merge: active.mergeStateFor(selectedWorktree?.worktree.root),
      write: writeFiles,
      commit: async (worktree, write) => {
        const outcome = await writes.write(worktree, write);
        focus.checkLost();
        return outcome;
      },
      confirmDiscard: askDiscard,
      confirmStash: askStash,
      lostFocus: () => focus.checkLost(),
    },
    discarding,
    closeDiscard: () => setDiscarding(null),
    stashing,
    closeStash: () => setStashing(null),
    actions: defineSlice({
      context: {
        worktree: selectedLists && {
          unstaged: selectedLists.get("unstaged")?.length ?? 0,
          staged: selectedLists.get("staged")?.length ?? 0,
          conflicts: selectedLists.get("conflict")?.length ?? 0,
          discardable:
            selectedChanges?.kind === "ready"
              ? discardChoice(
                  selectedChanges.status,
                  selectedLists.get("unstaged") ?? [],
                ).paths.length
              : 0,
        },
      },
      commands: {
        stageAll: () => writeList("unstaged"),
        unstageAll: () => writeList("staged"),
        discardAll: () => {
          const paths = selectedLists?.get("unstaged");
          if (selectedWorktree && paths)
            askDiscard(selectedWorktree.worktree.root, paths);
        },
        stashChanges: () => {
          if (selectedWorktree) askStash(selectedWorktree.worktree.root, []);
        },
      },
    }),
  };
}
