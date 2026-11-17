import { FolderMinus, Trash2 } from "lucide-react";
import { flushSync } from "react-dom";
import { BranchDialog } from "../components/BranchDialog";
import { CheckoutCommitDialog } from "../components/CheckoutCommitDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EditMessageDialog } from "../components/EditMessageDialog";
import { TagDialog } from "../components/TagDialog";
import { TryLocallyDialog } from "../components/TryLocallyDialog";
import { answeredInTagDialog, stashDropWrite } from "../domain/operations";
import { shortBranch } from "../domain/refs";
import type { RepositorySnapshot } from "../domain/repository";
import type { WritesView } from "../useWrites";
import { focusIsShown } from "./dom";
import type { Focus } from "./useFocus";
import type { Navigation } from "./useNavigation";
import type { RefWrites } from "./useRefWrites";

type Writes = Pick<WritesView, "write" | "dismiss">;

export function EditMessageHost({
  refWrites,
  writes,
  nav,
  focus,
}: {
  refWrites: RefWrites;
  writes: Writes;
  nav: Pick<Navigation, "selectHeadAfter">;
  focus: Pick<Focus, "fallback">;
}) {
  const { headStatus } = refWrites;
  if (!refWrites.editingMessage || !headStatus) return null;
  if (!refWrites.commitActions.editableHead) return null;
  return (
    <EditMessageDialog
      status={headStatus}
      onSave={async (worktree, write) => {
        const outcome = await writes.write(worktree, write);
        if (outcome.kind === "applied") nav.selectHeadAfter(worktree);
        return outcome;
      }}
      onClose={() => {
        flushSync(refWrites.closeEditMessage);
        focus.fallback();
      }}
    />
  );
}

export function BranchHost({
  refWrites,
  snapshot,
  writes,
  nav,
  focus,
}: {
  refWrites: RefWrites;
  snapshot: RepositorySnapshot | null;
  writes: Writes;
  nav: Pick<Navigation, "jumpTo">;
  focus: Pick<Focus, "fallback" | "focusNamedBranch">;
}) {
  const { branchAsk } = refWrites;
  if (!branchAsk || !snapshot) return null;
  return (
    <BranchDialog
      ask={branchAsk}
      root={snapshot.root}
      head={snapshot.head}
      onWrite={async (write) => {
        const outcome = await writes.write(snapshot.root, write);
        const shownInDialog =
          write.operation.kind === "createBranch" ||
          write.operation.kind === "renameBranch";
        if (outcome.kind === "failed" && shownInDialog) writes.dismiss();
        if (!focusIsShown()) focus.fallback();
        return outcome;
      }}
      onNamedBranch={(branch) => nav.jumpTo(snapshot.root, branch)}
      onClose={() => {
        refWrites.closeBranch();
        requestAnimationFrame(focus.focusNamedBranch);
      }}
    />
  );
}

export function TagHost({
  refWrites,
  snapshot,
  writes,
  nav,
  focus,
}: {
  refWrites: RefWrites;
  snapshot: RepositorySnapshot | null;
  writes: Writes;
  nav: Pick<Navigation, "followRefStep">;
  focus: Pick<Focus, "refocusIfLost">;
}) {
  const { tagAsk } = refWrites;
  if (!tagAsk || !snapshot) return null;
  return (
    <TagDialog
      ask={tagAsk}
      head={snapshot.head}
      onWrite={async (write) => {
        const { operation } = write;
        const outcome = await writes.write(snapshot.root, write);
        if (
          outcome.kind === "failed" &&
          operation.kind === "createTag" &&
          answeredInTagDialog(outcome.problem)
        )
          writes.dismiss();
        if (outcome.kind === "applied" && operation.kind === "deleteTag")
          nav.followRefStep({
            root: snapshot.root,
            left: null,
            gone: operation.tag.reference,
          });
        return outcome;
      }}
      onClose={() => {
        refWrites.closeTag();
        focus.refocusIfLost();
      }}
    />
  );
}

export function CheckoutCommitHost({ refWrites }: { refWrites: RefWrites }) {
  const { detaching } = refWrites;
  if (!detaching) return null;
  return (
    <CheckoutCommitDialog
      oid={detaching}
      onConfirm={() =>
        void refWrites.checkout({ kind: "commit", oid: detaching })
      }
      onClose={refWrites.closeDetach}
    />
  );
}

export function DropStashHost({
  refWrites,
  snapshot,
  writes,
}: {
  refWrites: RefWrites;
  snapshot: RepositorySnapshot | null;
  writes: Pick<WritesView, "write">;
}) {
  const { droppingStash } = refWrites;
  if (!droppingStash || !snapshot) return null;
  return (
    <ConfirmDialog
      icon={Trash2}
      title={`Drop ${droppingStash.name}?`}
      closeLabel="Close drop stash"
      confirm="Drop stash"
      onConfirm={() => {
        void writes.write(
          snapshot.root,
          stashDropWrite(droppingStash, snapshot.head),
        );
        refWrites.closeDrop();
      }}
      onClose={refWrites.closeDrop}
    >
      <p>
        {droppingStash.message} Undo puts this entry back at stash@{"{0}"}.
      </p>
    </ConfirmDialog>
  );
}

export function TryLocallyHost({
  refWrites,
  snapshot,
  focus,
}: {
  refWrites: RefWrites;
  snapshot: RepositorySnapshot | null;
  focus: Pick<Focus, "refocusIfLost">;
}) {
  const { tryAsk } = refWrites;
  if (!tryAsk || !snapshot) return null;
  return (
    <TryLocallyDialog
      root={snapshot.root}
      ask={tryAsk}
      onCreate={refWrites.createWorktree}
      onClose={() => {
        refWrites.closeTry();
        focus.refocusIfLost();
      }}
    />
  );
}

export function RemoveWorktreeHost({ refWrites }: { refWrites: RefWrites }) {
  const { removing } = refWrites;
  if (!removing) return null;
  const branch =
    removing.head.kind === "detached"
      ? "Its commits"
      : `${shortBranch(removing.head.reference)} and its commits`;
  return (
    <ConfirmDialog
      icon={FolderMinus}
      title={`Remove worktree ${removing.name}?`}
      closeLabel="Close remove worktree"
      confirm="Remove worktree"
      onConfirm={() => void refWrites.confirmRemove()}
      onClose={refWrites.closeRemove}
    >
      <p>
        Git deletes {removing.root}, including ignored files such as
        dependencies and build output, and refuses if it has uncommitted or
        untracked files. {branch} stay. This has no Undo, and Undo entries made
        in that worktree are dropped.
      </p>
    </ConfirmDialog>
  );
}
