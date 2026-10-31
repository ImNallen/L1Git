import type {
  Branch,
  FullRef,
  RepositoryRefs,
  RepositoryRoot,
  Tag,
} from "../domain/repository";

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
