import { useState } from "react";
import {
  branchAsks,
  checkoutWrite,
  nextEntry,
  refStep,
  stashApplyWrite,
  stashPopWrite,
  startAt,
  worktreeForStash,
} from "../domain/operations";
import type { BranchAsk, Step, TagAsk } from "../domain/operations";
import type {
  Branch,
  FullRef,
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
  Start,
  Stash,
  WorktreeStatus,
} from "../domain/repository";
import type { Selection } from "../domain/selection";
import type { ChangesByWorktree } from "../domain/worktree";
import type { WritesView } from "../useWrites";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { Focus } from "./useFocus";
import type { Navigation } from "./useNavigation";
import type { Staging } from "./useStaging";

/** History's commit-row write actions. */
export type CommitActions = {
  editableHead: Oid | null;
  onEditMessage: () => void;
  onNewBranch: (oid: Oid) => void;
  onCreateTag: (oid: Oid) => void;
  onCheckout: (oid: Oid) => void;
};

/** RepositoryTree's write actions. */
export type SidebarRefActions = {
  merge?: {
    root: RepositoryRoot;
    disabled: boolean;
    onSelect: (branch: Branch) => void;
  };
  writable: {
    root: RepositoryRoot;
    checkedOutIn: ReadonlyMap<FullRef, string>;
  } | null;
  onBranchAsk: (ask: BranchAsk) => void;
  onTagAsk: (ask: TagAsk) => void;
  onStashAction: (action: "apply" | "pop" | "drop", stash: Stash) => void;
  onCheckout: (branch: Branch) => void;
};

/**
 * Branch, tag, checkout, edit-message, and stash writes, and the dialogs that
 * ask for them. Follow-ups that move selection or focus are requests to
 * navigation and focus; this hook holds no navigation state.
 */
export type RefWrites = {
  commitActions: CommitActions;
  sidebarActions: SidebarRefActions;
  /** The repository root worktree's status, which Edit message rewrites. */
  headStatus: WorktreeStatus | null;
  editingMessage: boolean;
  closeEditMessage: () => void;
  branchAsk: BranchAsk | null;
  closeBranch: () => void;
  tagAsk: TagAsk | null;
  closeTag: () => void;
  detaching: Oid | null;
  closeDetach: () => void;
  droppingStash: Stash | null;
  closeDrop: () => void;
  checkout: (target: Start) => Promise<void>;
  actions: ActionSlice<
    never,
    | "checkout"
    | "newBranch"
    | "renameBranch"
    | "deleteBranch"
    | "createTag"
    | "deleteTag"
  >;
};

export function useRefWrites({
  snapshot,
  selection,
  changes,
  writes,
  nav,
  staging: { selectedWorktree },
  focus,
}: {
  snapshot: RepositorySnapshot | null;
  selection: Selection | null;
  changes: ChangesByWorktree;
  writes: Pick<WritesView, "write">;
  nav: Pick<Navigation, "jump" | "checkedOut">;
  staging: Pick<Staging, "selectedWorktree">;
  focus: Pick<Focus, "refocusIfLost">;
}): RefWrites {
  const [editingMessage, setEditingMessage] = useState(false);
  const [branchAsk, setBranchAsk] = useState<BranchAsk | null>(null);
  const [detaching, setDetaching] = useState<Oid | null>(null);
  const [tagAsk, setTagAsk] = useState<TagAsk | null>(null);
  const [droppingStash, setDroppingStash] = useState<Stash | null>(null);
  const { ruledBranch, sidebarTag } = nav.jump;
  function stashAction(action: "apply" | "pop" | "drop", stash: Stash) {
    if (!snapshot) return;
    if (action === "drop") {
      setDroppingStash(stash);
      return;
    }
    const target = worktreeForStash(
      snapshot,
      stash.message,
      selectedWorktree
        ? {
            root: selectedWorktree.worktree.root,
            head: selectedWorktree.worktree.head,
          }
        : null,
    );
    const write =
      action === "apply"
        ? stashApplyWrite(stash, target.head)
        : stashPopWrite(stash, target.head);
    void writes.write(target.root, write);
  }
  const rootChanges = snapshot ? changes.get(snapshot.root) : undefined;
  const headStatus = rootChanges?.kind === "ready" ? rootChanges.status : null;
  const editableHead =
    headStatus?.head.kind === "unborn" ? null : (headStatus?.head.oid ?? null);
  const askFor = (kind: keyof ReturnType<typeof branchAsks>) => () => {
    const ask = ruledBranch && branchAsks(ruledBranch)[kind];
    if (ask) setBranchAsk(ask);
  };
  const askTag = (oid: Oid) =>
    setTagAsk({
      kind: "create",
      at: oid,
      subject:
        snapshot?.commits.find((commit) => commit.oid === oid)?.subject ?? "",
    });
  async function checkout(target: Start) {
    if (!snapshot) return;
    await writes.write(snapshot.root, checkoutWrite(target, snapshot.head));
    focus.refocusIfLost();
  }
  return {
    commitActions: {
      editableHead,
      onEditMessage: () => setEditingMessage(true),
      onNewBranch: (oid) =>
        setBranchAsk({
          kind: "create",
          at: { kind: "commit", oid },
          from: `commit ${oid.slice(0, 7)}`,
        }),
      onCreateTag: askTag,
      onCheckout: setDetaching,
    },
    sidebarActions: {
      writable: snapshot && {
        root: snapshot.root,
        checkedOutIn: nav.checkedOut,
      },
      onBranchAsk: setBranchAsk,
      onTagAsk: setTagAsk,
      onStashAction: stashAction,
      onCheckout: (branch) => void checkout(startAt(branch)),
    },
    headStatus,
    editingMessage,
    closeEditMessage: () => setEditingMessage(false),
    branchAsk,
    closeBranch: () => setBranchAsk(null),
    tagAsk,
    closeTag: () => setTagAsk(null),
    detaching,
    closeDetach: () => setDetaching(null),
    droppingStash,
    closeDrop: () => setDroppingStash(null),
    checkout,
    actions: defineSlice({
      context: {},
      commands: {
        checkout: () => {
          if (ruledBranch) void checkout(startAt(ruledBranch));
        },
        newBranch: askFor("create"),
        renameBranch: askFor("rename"),
        deleteBranch: askFor("delete"),
        createTag: () => {
          if (selection?.kind === "commit") askTag(selection.oid);
        },
        deleteTag: () => {
          if (sidebarTag) setTagAsk({ kind: "delete", tag: sidebarTag });
        },
      },
    }),
  };
}

/**
 * Keyboard and palette undo and redo: read the entry before the step,
 * refocus after a checkout, then ask navigation to follow the moved ref. The
 * toolbar's undo buttons call `writes.undo` directly and skip all of this.
 */
export type UndoSteps = {
  actions: ActionSlice<"history", "undo" | "redo">;
};

export function useUndoSteps({
  writes,
  nav,
  focus,
}: {
  writes: Pick<WritesView, "history" | "undo" | "redo">;
  nav: Pick<Navigation, "followRefStep">;
  focus: Pick<Focus, "refocusIfLost">;
}): UndoSteps {
  async function step(step: Step) {
    const entry = nextEntry(writes.history, step);
    nav.followRefStep(null);
    const outcome = await writes[step]();
    if (entry?.operation.kind === "checkout") focus.refocusIfLost();
    const moved = entry && refStep(entry.operation, step);
    if (outcome.kind === "applied" && entry && moved)
      nav.followRefStep({ root: entry.root, ...moved });
  }
  return {
    actions: defineSlice({
      context: {
        history: {
          undo: nextEntry(writes.history, "undo")?.label ?? null,
          redo: nextEntry(writes.history, "redo")?.label ?? null,
        },
      },
      commands: {
        undo: () => void step("undo"),
        redo: () => void step("redo"),
      },
    }),
  };
}
