import { useEffect, useState } from "react";
import {
  draftImpact as currentDraftImpact,
  useDraftImpact,
} from "../draftProtection";
import type { RepositoryRoot, RepositorySnapshot } from "../domain/repository";

/**
 * Unsaved conflict results across repositories, and the one reopened in
 * RetainedResolution. App subscribes to the draft impact, so it re-renders on
 * every draft revision.
 */
export type ResolutionDrafts = {
  resolutions: readonly { root: RepositoryRoot; path: string }[];
  retained: { root: RepositoryRoot; path: string } | null;
  /** Closes the file, opens the result's repository unless the snapshot lists it, then shows the result. */
  openRetained: (root: RepositoryRoot, path: string) => void;
  closeRetained: () => void;
};

export function useResolutionDrafts({
  snapshot,
  closeFile,
  selectRepository,
}: {
  snapshot: RepositorySnapshot | null;
  closeFile: () => void;
  selectRepository: (root: RepositoryRoot) => Promise<unknown>;
}): ResolutionDrafts {
  const { resolutions } = useDraftImpact();
  const [retained, setRetained] = useState<{
    root: RepositoryRoot;
    path: string;
  } | null>(null);
  useEffect(() => {
    if (resolutions.length === 0) return;
    const protect = (event: BeforeUnloadEvent) => {
      if (currentDraftImpact().frozen) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [resolutions.length]);
  return {
    resolutions,
    retained,
    openRetained: (root, path) => {
      closeFile();
      void (
        snapshot?.root === root ||
        snapshot?.worktrees.some((worktree) => worktree.root === root)
          ? Promise.resolve()
          : selectRepository(root)
      ).then(() => setRetained({ root, path }));
    },
    closeRetained: () => setRetained(null),
  };
}
