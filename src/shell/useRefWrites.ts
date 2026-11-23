import { useState } from "react";
import {
  branchAsks,
  checkoutWrite,
  nextEntry,
  refStep,
  worktreeRemoval,
  stashApplyWrite,
  stashPopWrite,
  startAt,
  worktreeForStash,
} from "../domain/operations";
import type { BranchAsk, Step, TagAsk } from "../domain/operations";
import type { BranchRef, FastForwardOffer } from "../domain/overview";
import type {
  Branch,
  FullRef,
  NewWorktree,
  Oid,
  Problem,
  RepositoryRoot,
  RepositorySnapshot,
  Start,
  Stash,
  Worktree,
  WorktreeSource,
  WorktreeStatus,
} from "../domain/repository";
import type { Selection } from "../domain/selection";
import type { ChangesByWorktree } from "../domain/worktree";
import { busyProblem } from "../components/Dialog";
import type { CreateWorktreeOutcome, WritesView } from "../useWrites";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { Focus } from "./useFocus";
import type { Navigation } from "./useNavigation";
import type { Staging } from "./useStaging";
import type { WorkspaceApi } from "./workspaceView";
import { shortOid } from "../domain/shortOid";

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
  fastForward?: {
    root: RepositoryRoot;
    offer: (reference: FullRef) => FastForwardOffer | null;
    onSelect: (branch: BranchRef) => void;
  };
  writable: {
    root: RepositoryRoot;
    checkedOutIn: ReadonlyMap<FullRef, Worktree>;
  } | null;
  onBranchAsk: (ask: BranchAsk) => void;
  onTagAsk: (ask: TagAsk) => void;
  onStashAction: (action: "apply" | "pop" | "drop", stash: Stash) => void;
  onCheckout: (branch: Branch) => void;
  onTryLocally: (branch: Branch) => void;
  onRemoveWorktree: (worktree: Worktree) => void;
};

/** Try it locally's dialog: the branch the user picked, as the core takes it. */
export type TryAsk = { source: WorktreeSource; name: string };

/**
 * What a worktree write tells the user once its dialog has closed. It shows
 * only while the repository that made it is open, which is derived, so
 * nothing has to clear it.
 */
export type WorktreeNotice =
  | {
      kind: "created";
      from: RepositoryRoot;
      branch: string;
      created: NewWorktree;
    }
  | {
      kind: "removeFailed";
      from: RepositoryRoot;
      problem: Problem;
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
  tryAsk: TryAsk | null;
  closeTry: () => void;
  /** The dialog's Create. On success it saves the worktree to the sidebar and asks whether to open it. */
  createWorktree: (folder: string) => Promise<CreateWorktreeOutcome>;
  removing: Worktree | null;
  closeRemove: () => void;
  /** The confirm's action. On success it drops the worktree from the sidebar. */
  confirmRemove: () => Promise<void>;
  worktreeNotice: WorktreeNotice | null;
  dismissWorktreeNotice: () => void;
  actions: ActionSlice<
    never,
    | "checkout"
    | "newBranch"
    | "renameBranch"
    | "deleteBranch"
    | "tryLocally"
    | "removeWorktree"
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
  saved,
}: {
  snapshot: RepositorySnapshot | null;
  selection: Selection | null;
  changes: ChangesByWorktree;
  writes: Pick<
    WritesView,
    "write" | "createWorktree" | "removeWorktree" | "post"
  >;
  nav: Pick<Navigation, "jump" | "checkedOut" | "sidebar">;
  staging: Pick<Staging, "selectedWorktree">;
  focus: Pick<Focus, "refocusIfLost">;
  saved: Pick<WorkspaceApi, "keepRepository">;
}): RefWrites {
  const [editingMessage, setEditingMessage] = useState(false);
  const [branchAsk, setBranchAsk] = useState<BranchAsk | null>(null);
  const [detaching, setDetaching] = useState<Oid | null>(null);
  const [tagAsk, setTagAsk] = useState<TagAsk | null>(null);
  const [droppingStash, setDroppingStash] = useState<Stash | null>(null);
  const [tryAsk, setTryAsk] = useState<TryAsk | null>(null);
  const [removing, setRemoving] = useState<Worktree | null>(null);
  const [notice, setNotice] = useState<WorktreeNotice | null>(null);
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
  const tryLocally = (branch: Branch) =>
    setTryAsk({ source: startAt(branch), name: branch.name });
  async function createWorktree(
    folder: string,
  ): Promise<CreateWorktreeOutcome> {
    if (!snapshot || !tryAsk) return { kind: "busy" };
    const outcome = await writes.createWorktree(tryAsk.source, folder);
    if (outcome.kind === "created") {
      saved.keepRepository(outcome.created);
      setNotice({
        kind: "created",
        from: snapshot.root,
        branch: tryAsk.name,
        created: outcome.created,
      });
    }
    return outcome;
  }
  async function confirmRemove() {
    if (!snapshot || !removing) return;
    const from = snapshot.root;
    const outcome = await writes.removeWorktree(removing.root);
    if (outcome.kind === "removed") {
      nav.sidebar.onRemove(removing.root);
      setNotice(null);
      writes.post(from, { kind: "removedWorktree", name: removing.name });
      return;
    }
    setNotice({
      kind: "removeFailed",
      from,
      problem: outcome.kind === "busy" ? busyProblem : outcome.problem,
    });
  }
  const ruledRemoval = worktreeRemoval(
    ruledBranch ? nav.checkedOut.get(ruledBranch.reference) : undefined,
  );
  return {
    commitActions: {
      editableHead,
      onEditMessage: () => setEditingMessage(true),
      onNewBranch: (oid) =>
        setBranchAsk({
          kind: "create",
          at: { kind: "commit", oid },
          from: `commit ${shortOid(oid)}`,
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
      onTryLocally: tryLocally,
      onRemoveWorktree: setRemoving,
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
    tryAsk,
    closeTry: () => setTryAsk(null),
    createWorktree,
    removing,
    closeRemove: () => setRemoving(null),
    confirmRemove,
    worktreeNotice: notice?.from === snapshot?.root ? notice : null,
    dismissWorktreeNotice: () => setNotice(null),
    actions: defineSlice({
      context: {},
      commands: {
        checkout: () => {
          if (ruledBranch) void checkout(startAt(ruledBranch));
        },
        newBranch: askFor("create"),
        renameBranch: askFor("rename"),
        deleteBranch: askFor("delete"),
        tryLocally: () => {
          if (ruledBranch) tryLocally(ruledBranch);
        },
        removeWorktree: () => {
          if (ruledRemoval.kind === "linked")
            setRemoving(ruledRemoval.worktree);
        },
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
type UndoSteps = {
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
