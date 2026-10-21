import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as repositories from "./repositories";
import { problemFrom } from "./domain/repository";
import type {
  Branch,
  Problem,
  RepositoryRefs,
  RepositoryRoot,
  RepositorySnapshot,
} from "./domain/repository";
import type { OverviewStore } from "./overview";
import { freshSnapshot } from "./useWorkspace";
import type { Workspace } from "./useWorkspace";

export type RefsState =
  | { kind: "loading" }
  | { kind: "ready"; refs: RepositoryRefs }
  | { kind: "error"; problem: Problem };

type FreshBranches = (
  root: RepositoryRoot,
  branches: readonly Branch[],
) => void;

export function withOpenRepository(
  states: ReadonlyMap<RepositoryRoot, RefsState>,
  snapshot: RepositorySnapshot | null,
): ReadonlyMap<RepositoryRoot, RefsState> {
  if (snapshot === null || states.get(snapshot.root)?.kind === "ready")
    return states;
  return new Map(states).set(snapshot.root, { kind: "ready", refs: snapshot });
}

export class RepositoryRefsStore {
  #states: ReadonlyMap<RepositoryRoot, RefsState> = new Map();
  #latestReadId = new Map<RepositoryRoot, number>();
  #next = 0;
  #accepted: RepositorySnapshot | null = null;
  #listeners = new Set<() => void>();
  readonly #read: (root: RepositoryRoot) => Promise<RepositoryRefs>;
  readonly #onFreshBranches: FreshBranches;

  constructor(
    read: (root: RepositoryRoot) => Promise<RepositoryRefs>,
    onFreshBranches: FreshBranches,
  ) {
    this.#read = read;
    this.#onFreshBranches = onFreshBranches;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  states = () => this.#states;

  acceptFresh(workspace: Workspace) {
    const fresh = freshSnapshot(workspace);
    if (fresh === null || fresh === this.#accepted) return;
    this.#accepted = fresh;
    const { root, name, head, branches } = fresh;
    this.#latestReadId.set(root, ++this.#next);
    this.#write(root, { kind: "ready", refs: { root, name, head, branches } });
    this.#onFreshBranches(root, branches);
  }

  load(roots: readonly RepositoryRoot[]) {
    for (const root of roots) {
      const id = ++this.#next;
      this.#latestReadId.set(root, id);
      if (this.#states.get(root)?.kind !== "ready")
        this.#write(root, { kind: "loading" });
      void this.#read(root).then(
        (refs) => {
          if (this.#latestReadId.get(root) !== id) return;
          this.#write(root, { kind: "ready", refs });
          this.#onFreshBranches(root, refs.branches);
        },
        (error: unknown) => {
          if (this.#latestReadId.get(root) === id)
            this.#write(root, { kind: "error", problem: problemFrom(error) });
        },
      );
    }
  }

  forget(roots: readonly RepositoryRoot[]) {
    const known = roots.filter((root) => this.#states.has(root));
    for (const root of roots) this.#latestReadId.delete(root);
    if (known.length === 0) return;
    const next = new Map(this.#states);
    for (const root of known) next.delete(root);
    this.#states = next;
    this.#emit();
  }

  #write(root: RepositoryRoot, state: RefsState) {
    this.#states = new Map(this.#states).set(root, state);
    this.#emit();
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}

export function useRepositoryRefs(
  expanded: ReadonlySet<RepositoryRoot>,
  workspace: Workspace,
  shown: RepositorySnapshot | null,
  store: OverviewStore,
  onFreshBranches: FreshBranches,
) {
  const onFreshBranchesRef = useRef(onFreshBranches);
  useEffect(() => {
    onFreshBranchesRef.current = onFreshBranches;
  });
  const [refsStore] = useState(
    () =>
      new RepositoryRefsStore(repositories.refs, (root, branches) =>
        onFreshBranchesRef.current(root, branches),
      ),
  );
  const states = useSyncExternalStore(refsStore.subscribe, refsStore.states);
  const activeRoot = shown?.root ?? null;

  useEffect(() => refsStore.acceptFresh(workspace), [refsStore, workspace]);

  const background = useMemo(
    () => [...expanded].filter((root) => root !== activeRoot),
    [expanded, activeRoot],
  );

  useEffect(() => {
    refsStore.forget(
      [...refsStore.states().keys()].filter(
        (root) => root !== activeRoot && !expanded.has(root),
      ),
    );
  }, [refsStore, expanded, activeRoot]);

  useEffect(() => {
    const missing = background.filter((root) => !states.has(root));
    if (missing.length > 0) refsStore.load(missing);
  }, [refsStore, background, states]);

  useEffect(
    () =>
      store.onRefsChanged((roots) =>
        refsStore.load(background.filter((root) => roots.includes(root))),
      ),
    [store, refsStore, background],
  );

  const refs = useMemo(
    () => withOpenRepository(states, shown),
    [states, shown],
  );

  return { refs, reload: () => refsStore.load(background) };
}
