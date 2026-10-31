import { useEffect, useRef } from "react";
import type { RepositoryRoot } from "../domain/repository";
import type { OverviewStore, OverviewView } from "../overview";
import { useWrites } from "../useWrites";
import type { WritesView } from "../useWrites";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { OpenedRepository } from "./sync";
import type { ActiveWorktree } from "./useActiveWorktree";
import type { WorkspaceApi } from "./workspaceView";

/**
 * The one owner of "after a write, reread". In the shell, only this file calls
 * `refreshLocal` or `invalidatePush` and subscribes to `onRefsChanged`:
 *
 *   write starts   -> invalidatePush(commonDir)
 *   write ends     -> refreshLocal(commonDir) -> onRefsChanged
 *   onRefsChanged  -> rereadAll() when the active root changed
 *   ref-moving     -> reread.refs: refreshLocal + rereadOpenRepository
 *   window focus   -> refreshRepository() + reloadRefs(), 1 s throttle
 *
 * A ref-moving write and a window focus therefore request the snapshot more
 * than once; the refresh pins record the counts.
 */
export type WriteLoop = {
  writes: WritesView;
  /** Worktree statuses, undo history, and merge state; not the snapshot. */
  rereadChanges: () => void;
  rereadAll: () => Promise<void>;
  /** refreshLocal for the open repository, then rereadAll. */
  refreshRepository: () => Promise<void>;
  remoteAdded: (root: RepositoryRoot) => void;
  actions: ActionSlice<"writing">;
};

export function useWriteLoop({
  app,
  snapshotRoot,
  overview: { view, store },
  opened,
  active,
  reloadRefs,
}: {
  app: Pick<
    WorkspaceApi,
    | "rereadWorktree"
    | "rereadOpenRepository"
    | "refreshChanges"
    | "refresh"
    | "activeRoot"
  >;
  snapshotRoot: RepositoryRoot | null;
  overview: { view: OverviewView; store: OverviewStore };
  opened: OpenedRepository;
  active: Pick<ActiveWorktree, "root" | "refreshMerge">;
  reloadRefs: () => void;
}): WriteLoop {
  const writes = useWrites(
    snapshotRoot,
    {
      worktree: app.rereadWorktree,
      repository: app.rereadOpenRepository,
      refs: (worktree, repository) => {
        const state = view.roots.get(worktree) ?? view.roots.get(repository);
        if (state?.kind === "open") void store.refreshLocal(state.commonDir);
        return app.rereadOpenRepository(repository);
      },
    },
    active.root,
  );
  const writeCommonDir = opened.repository?.commonDir;
  useEffect(() => {
    if (writes.running === null || writeCommonDir === undefined) return;
    store.invalidatePush(writeCommonDir);
    return () => {
      void store.refreshLocal(writeCommonDir);
    };
  }, [writes.running, writeCommonDir, store]);
  const rereadChanges = () => {
    app.refreshChanges();
    writes.rereadHistory();
    active.refreshMerge();
  };
  const rereadAll = () => {
    rereadChanges();
    return app.refresh();
  };
  const refreshRepository = () => {
    if (opened.repository) void store.refreshLocal(opened.repository.commonDir);
    return rereadAll();
  };
  const refreshRef = useRef(rereadAll);
  const refreshRepositoryRef = useRef(refreshRepository);
  const reloadRefsRef = useRef(reloadRefs);
  useEffect(() => {
    refreshRef.current = rereadAll;
    refreshRepositoryRef.current = refreshRepository;
    reloadRefsRef.current = reloadRefs;
  });
  // Commits and branches made outside L1 Git show up when its window regains focus.
  useEffect(() => {
    let last = 0;
    const reread = () => {
      if (document.hidden || performance.now() - last < 1000) return;
      last = performance.now();
      void refreshRepositoryRef.current();
      reloadRefsRef.current();
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, []);
  const { activeRoot } = app;
  useEffect(
    () =>
      store.onRefsChanged((roots) => {
        if (roots.some((root) => root === activeRoot))
          void refreshRef.current();
      }),
    [store, activeRoot],
  );
  return {
    writes,
    rereadChanges,
    rereadAll,
    refreshRepository,
    remoteAdded: (root) => {
      const state = view.roots.get(root);
      if (state?.kind === "open") void store.refreshLocal(state.commonDir);
      void app.rereadOpenRepository(root);
    },
    actions: defineSlice({
      context: { writing: writes.running !== null },
      commands: {},
    }),
  };
}
