import type {
  Branch,
  FullRef,
  Oid,
  RepositoryRefs,
  RepositoryRoot,
  RepositorySnapshot,
  Tag,
} from "../domain/repository";
import { sameSelection } from "../domain/selection";
import type { Selection } from "../domain/selection";

/**
 * A branch jump. `pending` waits for the snapshot of `root` to load, then a
 * new `seq` reveals the branch after the history restores its scroll.
 */
export type Jump = {
  root: RepositoryRoot;
  reference: FullRef;
  seq: number;
  pending: boolean;
};

export type JumpTarget = Branch | Tag;

export const isBranch = (target: JumpTarget): target is Branch =>
  "kind" in target;

export function listedRef(
  refs: Pick<RepositoryRefs, "branches" | "tags">,
  reference: FullRef,
): JumpTarget | null {
  return (
    refs.branches.find((branch) => branch.reference === reference) ??
    refs.tags.find((tag) => tag.reference === reference) ??
    null
  );
}

/** What the last jump means for the screen right now. */
export type JumpView = {
  jumped: JumpTarget | null;
  /** The jumped ref points past the loaded commits. */
  jumpedUnloaded: boolean;
  /** The sidebar-clicked ref, loaded but hidden by the visibility rule. */
  hiddenJump: JumpTarget | null;
  highlighted: boolean;
  /** The branch the branch commands and `sidebarBranch` act on. */
  ruledBranch: Branch | null;
  sidebarTag: Tag | null;
};

export function jumpView({
  snapshot,
  jump,
  lastBranch,
  sidebarJump,
  selection,
  loaded,
  visibleOids,
}: {
  snapshot: RepositorySnapshot | null;
  jump: Jump | null;
  lastBranch: ReadonlyMap<RepositoryRoot, FullRef>;
  sidebarJump: { root: RepositoryRoot; reference: FullRef } | null;
  selection: Selection | null;
  loaded: ReadonlySet<Oid>;
  visibleOids: ReadonlySet<Oid>;
}): JumpView {
  const jumpedReference =
    snapshot && !(jump?.pending && jump.root === snapshot.root)
      ? lastBranch.get(snapshot.root)
      : undefined;
  const jumped =
    snapshot && jumpedReference ? listedRef(snapshot, jumpedReference) : null;
  const jumpedUnloaded = jumped !== null && !loaded.has(jumped.oid);
  const hiddenJump =
    jumped !== null &&
    sidebarJump?.root === snapshot?.root &&
    sidebarJump?.reference === jumped.reference &&
    !jumpedUnloaded &&
    !visibleOids.has(jumped.oid)
      ? jumped
      : null;
  const highlighted =
    jumped !== null &&
    sameSelection(selection, { kind: "commit", oid: jumped.oid });
  const ruledBranch =
    jumped && isBranch(jumped) && (highlighted || hiddenJump) ? jumped : null;
  const sidebarTag = jumped && !isBranch(jumped) ? jumped : null;
  return {
    jumped,
    jumpedUnloaded,
    hiddenJump,
    highlighted,
    ruledBranch,
    sidebarTag,
  };
}
