import { useCallback, useEffect, useRef, useState } from "react";
import * as repositories from "./repositories";
import {
  emptyCatalog,
  forget,
  persistCatalog,
  remember,
  restoreCatalog,
} from "./domain/recents";
import type { Catalog } from "./domain/recents";
import { problemFrom } from "./domain/repository";
import type {
  CommitDetail,
  FilePatch,
  FullRef,
  Oid,
  Problem,
  RepositoryRoot,
  RepositorySnapshot,
} from "./domain/repository";

type ReadyWorkspace = {
  kind: "ready";
  snapshot: RepositorySnapshot;
  reference: FullRef | null;
  error: Problem | null;
};
export type Workspace =
  | { kind: "empty" }
  | {
      kind: "loading";
      path: string;
      reference: FullRef | null;
      previous: ReadyWorkspace | null;
    }
  | { kind: "error"; path: string; error: Problem }
  | ReadyWorkspace;
export type DetailState =
  | { kind: "empty" }
  | { kind: "loading"; root: RepositoryRoot; oid: Oid }
  | { kind: "ready"; root: RepositoryRoot; oid: Oid; detail: CommitDetail }
  | { kind: "error"; root: RepositoryRoot; oid: Oid; error: Problem };
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
  const requestId = useRef(0);
  const current =
    workspace.kind === "ready"
      ? workspace
      : workspace.kind === "loading"
        ? workspace.previous
        : null;
  const root = current?.snapshot.root ?? null;

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
    (
      snapshot: RepositorySnapshot,
      reference: FullRef | null,
      rememberRepository: boolean,
    ) => {
      setWorkspace({ kind: "ready", snapshot, reference, error: null });
      setSelectedOid((selected) =>
        snapshot.commits.some((commit) => commit.oid === selected)
          ? selected
          : (snapshot.commits[0]?.oid ?? null),
      );
      if (rememberRepository) save(remember(catalogRef.current, snapshot));
    },
    [save],
  );

  const selectRepository = useCallback(
    async (path: string) => {
      const id = ++requestId.current;
      setWorkspace({ kind: "loading", path, reference: null, previous: null });
      setSelectedOid(null);
      try {
        const snapshot = await repositories.snapshot(path);
        if (id === requestId.current) accept(snapshot, null, true);
      } catch (error) {
        if (id === requestId.current)
          setWorkspace({ kind: "error", path, error: problemFrom(error) });
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
  ): Promise<Problem | null> => {
    const id = requestId.current;
    try {
      const snapshot = await repositories.snapshot(path);
      if (id === requestId.current && !signal.aborted) {
        requestId.current++;
        accept(snapshot, null, true);
      }
      return null;
    } catch (error) {
      return problemFrom(error);
    }
  };

  const browse = async (reference: FullRef | null) => {
    if (!current || workspace.kind === "loading") return;
    const id = ++requestId.current;
    const previous = current;
    setWorkspace({
      kind: "loading",
      path: current.snapshot.root,
      reference,
      previous,
    });
    try {
      const snapshot = await repositories.snapshot(
        current.snapshot.root,
        reference,
      );
      if (id === requestId.current) accept(snapshot, reference, false);
    } catch (error) {
      if (id === requestId.current)
        setWorkspace({ ...previous, error: problemFrom(error) });
    }
  };

  const removeRepository = (removed: RepositoryRoot) => {
    save(forget(catalogRef.current, removed));
    if (
      root === removed ||
      (workspace.kind === "error" && workspace.path === removed) ||
      (workspace.kind === "loading" && workspace.path === removed)
    ) {
      requestId.current++;
      setWorkspace({ kind: "empty" });
      setSelectedOid(null);
    }
  };

  useEffect(() => {
    if (root === null || selectedOid === null) {
      setDetail({ kind: "empty" });
      return;
    }
    let cancelled = false;
    setDetail({ kind: "loading", root, oid: selectedOid });
    void repositories.commitDetail(root, selectedOid).then(
      (detail) => {
        if (!cancelled)
          setDetail({ kind: "ready", root, oid: selectedOid, detail });
      },
      (error: unknown) => {
        if (!cancelled)
          setDetail({
            kind: "error",
            root,
            oid: selectedOid,
            error: problemFrom(error),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [root, selectedOid, detailAttempt]);

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
    closeFile,
    selectRepository,
    addRepository,
    removeRepository,
    browse,
  };
}
