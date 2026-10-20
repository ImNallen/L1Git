import { useCallback, useEffect, useRef, useState } from "react";
import * as repositories from "./repositories";
import { firstChangedPath } from "./domain/changedFiles";
import { latestReader } from "./latestReader";
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
import type {
  CommitDetail,
  FilePatch,
  Oid,
  Problem,
  RepositoryRoot,
  RepositorySnapshot,
} from "./domain/repository";

type ReadyWorkspace = {
  kind: "ready";
  snapshot: RepositorySnapshot;
  error: Problem | null;
};
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
export type DetailState =
  | { kind: "empty" }
  | { kind: "loading"; root: RepositoryRoot; oid: Oid }
  | { kind: "ready"; root: RepositoryRoot; oid: Oid; detail: CommitDetail }
  | { kind: "error"; root: RepositoryRoot; oid: Oid; error: Problem };
/** `superseded` means another repository opened while this one was read. */
export type Added =
  | { kind: "opened"; root: RepositoryRoot }
  | { kind: "superseded" }
  | { kind: "failed"; problem: Problem };
type FileKey = { root: RepositoryRoot; oid: Oid; path: string };
export type FileDiffState =
  | { kind: "closed" }
  | ({ kind: "loading" } & FileKey)
  | ({ kind: "ready"; patch: FilePatch } & FileKey)
  | ({ kind: "error"; error: Problem } & FileKey);

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
  const [selectedOid, setSelectedOid] = useState<Oid | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: "empty" });
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [fileDiff, setFileDiff] = useState<FileDiffState>({ kind: "closed" });
  const [pendingOpen, setPendingOpen] = useState<Omit<FileKey, "path"> | null>(
    null,
  );
  const requestId = useRef(0);
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
      setSelectedOid((selected) => restoreSelection(snapshot, selected));
      if (rememberRepository) save(remember(catalogRef.current, snapshot));
    },
    [save],
  );

  const selectRepository = useCallback(
    async (path: RepositoryRoot) => {
      const id = ++requestId.current;
      const remembered = views.current.get(path)?.selectedOid ?? null;
      const cached = snapshots.current.get(path);
      const previous: ReadyWorkspace | null = cached
        ? { kind: "ready", snapshot: cached, error: null }
        : null;
      if (previous) {
        snapshots.current = cacheSnapshot(snapshots.current, previous.snapshot);
        setWorkspace({ kind: "loading", path, previous });
        setSelectedOid(restoreSelection(previous.snapshot, remembered));
      } else {
        const name =
          catalogRef.current.entries.find((entry) => entry.root === path)
            ?.name ?? path;
        setWorkspace({ kind: "opening", path, name });
        setSelectedOid(remembered);
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
      setSelectedOid(views.current.get(snapshot.root)?.selectedOid ?? null);
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
      setSelectedOid(null);
    }
  };

  useEffect(() => {
    if (root === null) return;
    views.current.set(root, {
      ...(views.current.get(root) ?? emptyView),
      selectedOid,
    });
  }, [root, selectedOid]);

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

  const [detailReader] = useState(() =>
    latestReader<{ root: RepositoryRoot; oid: Oid }, CommitDetail>({
      read: (key) => repositories.commitDetail(key.root, key.oid),
      deliver: (key, outcome) =>
        setDetail(
          outcome.ok
            ? { kind: "ready", ...key, detail: outcome.value }
            : { kind: "error", ...key, error: problemFrom(outcome.error) },
        ),
      same: (left, right) => left.root === right.root && left.oid === right.oid,
      stallMs: 1000,
    }),
  );

  useEffect(() => {
    if (root === null || selectedOid === null) {
      detailReader.want(null);
      setDetail({ kind: "empty" });
      return;
    }
    detailReader.want({ root, oid: selectedOid });
    setDetail({ kind: "loading", root, oid: selectedOid });
  }, [root, selectedOid, detailAttempt, detailReader]);

  useEffect(() => {
    setFileDiff({ kind: "closed" });
  }, [root, selectedOid]);

  const closeFile = useCallback(() => setFileDiff({ kind: "closed" }), []);

  const openFile = (path: string) => {
    if (root === null || selectedOid === null) return;
    const key: FileKey = { root, oid: selectedOid, path };
    const pending = (state: FileDiffState) =>
      state.kind === "loading" &&
      state.root === key.root &&
      state.oid === key.oid &&
      state.path === key.path;
    setFileDiff({ kind: "loading", ...key });
    void repositories.filePatch(key.root, key.oid, key.path).then(
      (patch) =>
        setFileDiff((state) =>
          pending(state) ? { kind: "ready", ...key, patch } : state,
        ),
      (error: unknown) =>
        setFileDiff((state) =>
          pending(state)
            ? { kind: "error", ...key, error: problemFrom(error) }
            : state,
        ),
    );
  };

  useEffect(() => {
    if (pendingOpen === null) return;
    if (pendingOpen.root !== root || pendingOpen.oid !== selectedOid) {
      setPendingOpen(null);
      return;
    }
    if (
      detail.kind === "empty" ||
      detail.kind === "loading" ||
      detail.root !== root ||
      detail.oid !== selectedOid
    )
      return;
    setPendingOpen(null);
    if (detail.kind === "error") return;
    const path = firstChangedPath(detail.detail.files);
    if (path !== undefined) openFile(path);
  }, [pendingOpen, detail, root, selectedOid]);

  return {
    workspace,
    current,
    catalog,
    persistenceError,
    selectedOid,
    setSelectedOid,
    detail,
    retryDetail: () => setDetailAttempt((attempt) => attempt + 1),
    fileDiff,
    openFile,
    cancelOpenFirstFile: () => setPendingOpen(null),
    openFirstFile: () => {
      if (root !== null && selectedOid !== null)
        setPendingOpen({ root, oid: selectedOid });
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
