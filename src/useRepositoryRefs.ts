import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as repositories from "./repositories";
import { problemFrom } from "./domain/repository";
import type {
  Problem,
  RepositoryRefs,
  RepositoryRoot,
  RepositorySnapshot,
} from "./domain/repository";
import type { OverviewStore } from "./overview";

export type RefsState =
  | { kind: "loading" }
  | { kind: "ready"; refs: RepositoryRefs }
  | { kind: "error"; problem: Problem };

/**
 * Branch data for every expanded repository. The open repository reads it from
 * its snapshot. The others read only their refs, which skips the history walk.
 */
export function useRepositoryRefs(
  expanded: ReadonlySet<RepositoryRoot>,
  snapshot: RepositorySnapshot | null,
  store: OverviewStore,
) {
  const [states, setStates] = useState<ReadonlyMap<RepositoryRoot, RefsState>>(
    new Map(),
  );
  // The latest request per root. A response from an older request is stale.
  const requests = useRef(new Map<RepositoryRoot, number>());
  const nextRequest = useRef(0);
  const activeRoot = snapshot?.root ?? null;

  const load = useCallback((roots: readonly RepositoryRoot[]) => {
    for (const root of roots) {
      const id = ++nextRequest.current;
      requests.current.set(root, id);
      const settle = (state: RefsState) => {
        if (requests.current.get(root) === id)
          setStates((previous) => new Map(previous).set(root, state));
      };
      // A reread keeps showing the branches it already has.
      setStates((previous) =>
        previous.get(root)?.kind === "ready"
          ? previous
          : new Map(previous).set(root, { kind: "loading" }),
      );
      void repositories.refs(root).then(
        (refs) => settle({ kind: "ready", refs }),
        (error: unknown) =>
          settle({ kind: "error", problem: problemFrom(error) }),
      );
    }
  }, []);

  const background = useMemo(
    () => [...expanded].filter((root) => root !== activeRoot),
    [expanded, activeRoot],
  );

  // Keep the open repository's branches, so they stay visible after another
  // repository opens. Bumping its request drops an older refs response.
  useEffect(() => {
    if (snapshot === null) return;
    const { root, name, head, branches } = snapshot;
    requests.current.set(root, ++nextRequest.current);
    setStates((previous) =>
      new Map(previous).set(root, {
        kind: "ready",
        refs: { root, name, head, branches },
      }),
    );
  }, [snapshot]);

  useEffect(() => {
    setStates((previous) => {
      const collapsed = [...previous.keys()].filter(
        (root) => root !== activeRoot && !expanded.has(root),
      );
      if (collapsed.length === 0) return previous;
      const next = new Map(previous);
      for (const root of collapsed) {
        next.delete(root);
        requests.current.delete(root);
      }
      return next;
    });
  }, [expanded, activeRoot]);

  useEffect(() => {
    const missing = background.filter((root) => !states.has(root));
    if (missing.length > 0) load(missing);
  }, [background, states, load]);

  useEffect(
    () =>
      store.onRefsChanged((roots) =>
        load(background.filter((root) => roots.includes(root))),
      ),
    [store, background, load],
  );

  const refs = useMemo(
    (): ReadonlyMap<RepositoryRoot, RefsState> =>
      snapshot === null
        ? states
        : new Map(states).set(snapshot.root, {
            kind: "ready",
            refs: snapshot,
          }),
    [states, snapshot],
  );

  return { refs, reload: () => load(background) };
}
