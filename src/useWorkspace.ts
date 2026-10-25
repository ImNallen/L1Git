import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as repositories from "./repositories";
import { firstChangedPath } from "./domain/changedFiles";
import {
  compared,
  compareListed,
  sameComparison,
  singleCommit,
  swapEnds,
} from "./domain/comparison";
import type { Compare, Comparison } from "./domain/comparison";
import { latestReader } from "./latestReader";
import { oneReadPerKey } from "./oneReadPerKey";
import {
  emptyCatalog,
  forget,
  persistCatalog,
  remember,
  restoreCatalog,
} from "./domain/recents";
import type { Catalog } from "./domain/recents";
import { problemFrom } from "./domain/repository";
import {
  cacheSnapshot,
  emptyView,
  evictSnapshot,
  restoreSelection,
} from "./domain/revisit";
import type { RepositoryView, SnapshotCache } from "./domain/revisit";
import { sameSelection, stableSelection } from "./domain/selection";
import type { Selection } from "./domain/selection";
import {
  firstWorktreeFile,
  openDiffAfter,
  patchSide,
  worktreeGroups,
} from "./domain/worktree";
import type {
  ChangesByWorktree,
  ListSide,
  WorktreeChanges,
} from "./domain/worktree";
import type {
  CommitDetail,
  Problem,
  RepositoryRoot,
  RepositorySnapshot,
  WorktreePatch,
} from "./domain/repository";

type ReadyWorkspace = {
  kind: "ready";
  snapshot: RepositorySnapshot;
  error: Problem | null;
};
export function freshSnapshot(workspace: Workspace): RepositorySnapshot | null {
  return workspace.kind === "ready" && workspace.error === null
    ? workspace.snapshot
    : null;
}

/**
 * `opening` reads a repository with nothing to show yet. `loading` rereads
 * one while its last snapshot stays on screen.
 */
export type Workspace =
  | { kind: "empty" }
  | { kind: "opening"; path: RepositoryRoot; name: string }
  | { kind: "loading"; path: RepositoryRoot; previous: ReadyWorkspace }
  | { kind: "error"; path: RepositoryRoot; error: Problem }
  | ReadyWorkspace;
type DetailKey = {
  root: RepositoryRoot;
  comparison: Comparison;
  targetStatusReads: number;
};
export type DetailState =
  | { kind: "empty" }
  | ({ kind: "loading" } & DetailKey)
  | ({ kind: "ready"; detail: CommitDetail } & DetailKey)
  | ({ kind: "error"; error: Problem } & DetailKey);
/** `superseded` means another repository opened while this one was read. */
export type Added =
  | { kind: "opened"; root: RepositoryRoot }
  | { kind: "superseded" }
  | { kind: "failed"; problem: Problem };
type WorktreeSelection = Extract<Selection, { kind: "worktree" }>;
type FileKey = { root: RepositoryRoot; path: string } & (
  | { comparison: Comparison; side: null }
  | { selection: WorktreeSelection; side: ListSide }
);
export type FileDiffState =
  | { kind: "closed" }
  | ({ kind: "loading" } & FileKey)
  | ({ kind: "ready"; patch: WorktreePatch } & FileKey)
  | ({ kind: "error"; error: Problem } & FileKey);

function sameChanges(
  left: WorktreeChanges | undefined,
  right: WorktreeChanges,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export function useWorkspace() {
  const [saved] = useState(() => {
    try {
      return restoreCatalog(localStorage);
    } catch {
      return {
        catalog: emptyCatalog,
        error:
          "Local storage is unavailable. Repositories will not be restored after restart.",
      };
    }
  });
  const [catalog, setCatalog] = useState(saved.catalog);
  const catalogRef = useRef(catalog);
  const [persistenceError, setPersistenceError] = useState(saved.error);
  const [workspace, setWorkspace] = useState<Workspace>({ kind: "empty" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: "empty" });
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [fileDiff, setFileDiff] = useState<FileDiffState>({ kind: "closed" });
  const [compare, setCompare] = useState<Compare | null>(null);
  const [pendingOpen, setPendingOpen] = useState<{
    root: RepositoryRoot;
    selection: Selection;
    compare: Compare | null;
  } | null>(null);
  const [changes, setChanges] = useState<ChangesByWorktree>(new Map());
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const [changesAttempt, setChangesAttempt] = useState(0);
  const requestId = useRef(0);
  const fileRead = useRef(0);
  const snapshots = useRef<SnapshotCache>(new Map());
  const views = useRef(new Map<RepositoryRoot, RepositoryView>());
  const current =
    workspace.kind === "ready"
      ? workspace
      : workspace.kind === "loading"
        ? workspace.previous
        : null;
  const root = current?.snapshot.root ?? null;
  const activeRoot =
    workspace.kind === "loading" || workspace.kind === "opening"
      ? workspace.path
      : root;
  const activeCompare =
    compare !== null &&
    compare.root === root &&
    sameSelection(compare.anchor, selection)
      ? compare
      : null;
  const comparisonKey = activeCompare
    ? JSON.stringify(compared(activeCompare))
    : selection?.kind === "commit"
      ? JSON.stringify(singleCommit(selection.oid))
      : null;
  const comparison = useMemo(
    () =>
      comparisonKey === null ? null : (JSON.parse(comparisonKey) as Comparison),
    [comparisonKey],
  );

  const save = useCallback((next: Catalog) => {
    catalogRef.current = next;
    setCatalog(next);
    try {
      setPersistenceError(persistCatalog(localStorage, next));
    } catch {
      setPersistenceError(
        "Local storage is unavailable. Repositories will not be restored after restart.",
      );
    }
  }, []);

  const accept = useCallback(
    (snapshot: RepositorySnapshot, rememberRepository: boolean) => {
      snapshots.current = cacheSnapshot(snapshots.current, snapshot);
      setWorkspace({ kind: "ready", snapshot, error: null });
      setSelection((selected) =>
        restoreSelection(snapshot, selected, changesRef.current),
      );
      setCompare((kept) =>
        kept === null ||
        kept.root !== snapshot.root ||
        compareListed(snapshot, kept)
          ? kept
          : null,
      );
      if (rememberRepository) save(remember(catalogRef.current, snapshot));
    },
    [save],
  );

  const selectRepository = useCallback(
    async (path: RepositoryRoot) => {
      const id = ++requestId.current;
      const remembered = views.current.get(path)?.selection ?? null;
      const cached = snapshots.current.get(path);
      const previous: ReadyWorkspace | null = cached
        ? { kind: "ready", snapshot: cached, error: null }
        : null;
      if (previous) {
        snapshots.current = cacheSnapshot(snapshots.current, previous.snapshot);
        setWorkspace({ kind: "loading", path, previous });
        setSelection(
          restoreSelection(previous.snapshot, remembered, changesRef.current),
        );
      } else {
        const name =
          catalogRef.current.entries.find((entry) => entry.root === path)
            ?.name ?? path;
        setWorkspace({ kind: "opening", path, name });
        setSelection(remembered);
      }
      try {
        const snapshot = await repositories.snapshot(path);
        if (id === requestId.current) accept(snapshot, true);
      } catch (error) {
        if (id === requestId.current)
          setWorkspace(
            previous
              ? { ...previous, error: problemFrom(error) }
              : { kind: "error", path, error: problemFrom(error) },
          );
      }
    },
    [accept],
  );

  useEffect(() => {
    if (saved.catalog.lastRoot !== null)
      void selectRepository(saved.catalog.lastRoot);
    return () => {
      requestId.current++;
    };
  }, [saved.catalog.lastRoot, selectRepository]);

  const addRepository = async (
    path: string,
    signal: AbortSignal,
  ): Promise<Added> => {
    const id = requestId.current;
    try {
      const snapshot = await repositories.snapshot(path);
      if (id !== requestId.current || signal.aborted)
        return { kind: "superseded" };
      requestId.current++;
      setSelection(views.current.get(snapshot.root)?.selection ?? null);
      accept(snapshot, true);
      return { kind: "opened", root: snapshot.root };
    } catch (error) {
      return { kind: "failed", problem: problemFrom(error) };
    }
  };

  const refresh = async () => {
    if (workspace.kind === "opening") {
      await selectRepository(workspace.path);
      return;
    }
    if (!current) return;
    const path = current.snapshot.root;
    const id = ++requestId.current;
    const previous = current;
    setWorkspace({ kind: "loading", path, previous });
    try {
      const snapshot = await repositories.snapshot(path);
      if (id === requestId.current) accept(snapshot, false);
    } catch (error) {
      if (id === requestId.current)
        setWorkspace({ ...previous, error: problemFrom(error) });
    }
  };

  const removeRepository = (removed: RepositoryRoot) => {
    save(forget(catalogRef.current, removed));
    snapshots.current = evictSnapshot(snapshots.current, removed);
    views.current.delete(removed);
    if (
      (workspace.kind === "error" ? workspace.path : activeRoot) === removed
    ) {
      requestId.current++;
      setWorkspace({ kind: "empty" });
      setSelection(null);
    }
  };

  useEffect(() => {
    if (root === null) return;
    views.current.set(root, {
      ...(views.current.get(root) ?? emptyView),
      selection,
    });
  }, [root, selection]);

  const scrollTopOf = useCallback(
    (root: RepositoryRoot) => views.current.get(root)?.scrollTop ?? 0,
    [],
  );
  const rememberScroll = useCallback(
    (root: RepositoryRoot, scrollTop: number) => {
      views.current.set(root, {
        ...(views.current.get(root) ?? emptyView),
        scrollTop,
      });
    },
    [],
  );

  const [statusReads, setStatusReads] = useState<
    ReadonlyMap<RepositoryRoot, number>
  >(new Map());
  const statusRead = useRef(
    (_worktree: RepositoryRoot, _next: WorktreeChanges) => {},
  );
  const [readStatus] = useState(() => {
    const settle = (worktree: RepositoryRoot, next: WorktreeChanges) => {
      setChanges((previous) =>
        sameChanges(previous.get(worktree), next)
          ? previous
          : new Map(previous).set(worktree, next),
      );
      setStatusReads((previous) =>
        new Map(previous).set(worktree, (previous.get(worktree) ?? 0) + 1),
      );
      statusRead.current(worktree, next);
    };
    return oneReadPerKey((worktree: RepositoryRoot) =>
      repositories.worktreeStatus(worktree).then(
        (status) => settle(worktree, { kind: "ready", status }),
        (error: unknown) =>
          settle(worktree, { kind: "error", error: problemFrom(error) }),
      ),
    );
  });
  const worktrees = current?.snapshot.worktrees;
  const worktreesRef = useRef(worktrees);
  worktreesRef.current = worktrees;
  const worktreeKey = worktrees?.map((worktree) => worktree.root).join("\0");
  useEffect(() => {
    for (const worktree of worktreesRef.current ?? [])
      void readStatus(worktree.root);
  }, [worktreeKey, changesAttempt, readStatus]);

  useEffect(() => {
    if (current === null || selection?.kind !== "worktree") return;
    const next = restoreSelection(current.snapshot, selection, changes);
    if (!sameSelection(next, selection)) setSelection(next);
  }, [current, selection, changes]);

  const [detailReader] = useState(() =>
    latestReader<DetailKey, CommitDetail>({
      read: (key) => repositories.commitDetail(key.root, key.comparison),
      deliver: (key, outcome) =>
        setDetail(
          outcome.ok
            ? { kind: "ready", ...key, detail: outcome.value }
            : { kind: "error", ...key, error: problemFrom(outcome.error) },
        ),
      same: (left, right) =>
        left.root === right.root &&
        left.targetStatusReads === right.targetStatusReads &&
        sameComparison(left.comparison, right.comparison),
      stallMs: 1000,
      maxReads: 2,
    }),
  );

  const targetStatusReads =
    comparison?.target.kind === "worktree"
      ? (statusReads.get(comparison.target.root) ?? 0)
      : 0;
  useEffect(() => {
    if (root === null || comparison === null) {
      detailReader.want(null);
      setDetail({ kind: "empty" });
      return;
    }
    detailReader.want({ root, comparison, targetStatusReads });
    setDetail((shown) =>
      shown.kind === "ready" &&
      shown.root === root &&
      sameComparison(shown.comparison, comparison)
        ? shown
        : { kind: "loading", root, comparison, targetStatusReads },
    );
  }, [root, comparison, detailAttempt, detailReader, targetStatusReads]);

  useEffect(() => {
    setFileDiff({ kind: "closed" });
  }, [root, selection, comparison]);

  const closeFile = useCallback(() => setFileDiff({ kind: "closed" }), []);

  const select = useCallback((next: Selection) => {
    setCompare(null);
    setSelection((previous) => stableSelection(previous, next));
  }, []);

  const compareWith = useCallback((next: Compare) => {
    setCompare(next);
    setSelection((previous) => stableSelection(previous, next.anchor));
  }, []);

  const openFile = (path: string, side: ListSide | null, keepShown = false) => {
    if (root === null || selection === null) return;
    const key: FileKey | null =
      comparison !== null
        ? { root, comparison, path, side: null }
        : selection.kind === "worktree" && side !== null
          ? { root, selection, path, side }
          : null;
    if (key === null) return;
    const read = ++fileRead.current;
    const pending = (state: FileDiffState) =>
      read === fileRead.current &&
      state.kind !== "closed" &&
      state.root === key.root &&
      state.path === key.path;
    if (!keepShown) setFileDiff({ kind: "loading", ...key });
    const reading: Promise<WorktreePatch> =
      key.side === null
        ? repositories
            .filePatch(key.root, key.comparison, key.path)
            .then((diff) => ({ kind: "diff", diff }))
        : repositories.worktreePatch(
            key.selection.root,
            key.path,
            patchSide(key.side),
          );
    void reading.then(
      (patch) =>
        setFileDiff((state) =>
          pending(state) ? { kind: "ready", ...key, patch } : state,
        ),
      (error: unknown) => {
        const problem = problemFrom(error);
        setFileDiff((state) =>
          !pending(state)
            ? state
            : keepShown && problem.kind === "unchangedPath"
              ? { kind: "closed" }
              : { kind: "error", ...key, error: problem },
        );
      },
    );
  };

  useEffect(() => {
    statusRead.current = (worktree, next) => {
      if (fileDiff.kind === "closed" || next.kind !== "ready") return;
      if (fileDiff.side === null) {
        const { target } = fileDiff.comparison;
        if (target.kind === "worktree" && target.root === worktree)
          openFile(fileDiff.path, null, true);
        return;
      }
      if (fileDiff.selection.root !== worktree) return;
      const after = openDiffAfter(
        next.status.entries,
        fileDiff.path,
        fileDiff.side,
      );
      if (after.kind === "close") setFileDiff({ kind: "closed" });
      else
        openFile(
          fileDiff.path,
          after.kind === "follow" ? after.side : fileDiff.side,
          true,
        );
    };
  });

  useEffect(() => {
    if (
      fileDiff.kind !== "closed" &&
      fileDiff.side === null &&
      detail.kind === "ready" &&
      detail.root === fileDiff.root &&
      sameComparison(detail.comparison, fileDiff.comparison) &&
      !detail.detail.files.some((file) => file.path === fileDiff.path)
    )
      setFileDiff({ kind: "closed" });
  }, [detail, fileDiff]);

  useEffect(() => {
    if (pendingOpen === null) return;
    if (
      pendingOpen.root !== root ||
      !sameSelection(pendingOpen.selection, selection) ||
      pendingOpen.compare !== activeCompare
    ) {
      setPendingOpen(null);
      return;
    }
    if (comparison === null && selection?.kind === "worktree") {
      const found = changes.get(selection.root);
      if (found === undefined) return;
      setPendingOpen(null);
      if (found.kind === "error") return;
      const file = firstWorktreeFile(worktreeGroups(found.status.entries));
      if (file !== null) openFile(file.path, file.side);
      return;
    }
    if (
      comparison === null ||
      detail.kind === "empty" ||
      detail.kind === "loading" ||
      detail.root !== root ||
      !sameComparison(detail.comparison, comparison)
    )
      return;
    setPendingOpen(null);
    if (detail.kind === "error") return;
    const path = firstChangedPath(detail.detail.files);
    if (path !== undefined) openFile(path, null);
  }, [
    pendingOpen,
    detail,
    changes,
    root,
    selection,
    comparison,
    activeCompare,
  ]);

  return {
    workspace,
    current,
    catalog,
    persistenceError,
    selection,
    select,
    compare: activeCompare,
    compareWith,
    swapCompare: () => {
      const swapped = activeCompare && swapEnds(activeCompare);
      if (swapped) setCompare(swapped);
    },
    endCompare: () => setCompare(null),
    comparison,
    detail,
    changes,
    refreshChanges: () => setChangesAttempt((attempt) => attempt + 1),
    rereadWorktree: readStatus,
    retryDetail: () => setDetailAttempt((attempt) => attempt + 1),
    fileDiff,
    openFile,
    cancelOpenFirstFile: () => setPendingOpen(null),
    openFirstFile: () => {
      if (root !== null && selection !== null)
        setPendingOpen({ root, selection, compare: activeCompare });
    },
    closeFile,
    selectRepository,
    addRepository,
    removeRepository,
    refresh,
    activeRoot,
    scrollTopOf,
    rememberScroll,
  };
}
