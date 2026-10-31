import type { RepositoryRoot, RepositorySnapshot } from "../domain/repository";
import type { useWorkspace } from "../useWorkspace";

export type WorkspaceApi = ReturnType<typeof useWorkspace>;

export type WorkspaceView = {
  /** On screen, including the cached snapshot shown while the repository loads. */
  snapshot: RepositorySnapshot | null;
  /**
   * A `ready` workspace's snapshot, with or without a read error. A cached
   * snapshot can predate the branch, tag, or stash clicked in the sidebar, so
   * pending selections resolve against this, never against `snapshot`. Not
   * `freshSnapshot()` from useWorkspace, which also drops `ready` with an error.
   */
  settled: RepositorySnapshot | null;
  shown: { root: RepositoryRoot; name: string } | null;
  opening: { path: RepositoryRoot; name: string } | null;
  busy: boolean;
  fileOpen: boolean;
  activePath: RepositoryRoot | null;
};

export function workspaceView({
  workspace,
  current,
  fileDiff,
}: Pick<WorkspaceApi, "workspace" | "current" | "fileDiff">): WorkspaceView {
  const snapshot = current?.snapshot ?? null;
  const opening = workspace.kind === "opening" ? workspace : null;
  const shown = snapshot
    ? { root: snapshot.root, name: snapshot.name }
    : opening && { root: opening.path, name: opening.name };
  return {
    snapshot,
    settled: workspace.kind === "ready" ? workspace.snapshot : null,
    shown,
    opening,
    busy: workspace.kind === "loading" || workspace.kind === "opening",
    fileOpen: fileDiff.kind !== "closed",
    activePath:
      shown?.root ?? (workspace.kind === "error" ? workspace.path : null),
  };
}
