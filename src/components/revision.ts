import type { FileDiffState } from "../useWorkspace";
import type { Revision } from "./FileRevisions";

/** History and blame read the file in the target commit, which a worktree does not have. */
export function revisionOf(
  state: Exclude<FileDiffState, { kind: "closed" }>,
): Revision | null {
  if (state.side !== null || state.comparison.target.kind !== "commit")
    return null;
  return {
    root: state.root,
    oid: state.comparison.target.oid,
    path: state.path,
  };
}
