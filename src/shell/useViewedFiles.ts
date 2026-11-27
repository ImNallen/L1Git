import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RangeFile } from "../domain/range";
import { markOf, pullName, viewedAmong } from "../domain/viewedFiles";
import { sinceShown } from "../filesChanged";
import type { FilesChanged } from "../filesChanged";
import { browserStorage } from "../persisted";
import { createViewedFiles } from "../viewedFiles";

const none: readonly RangeFile[] = [];

/**
 * Which files of the Files changed tab are viewed. A mark is the pull
 * request's file's, so a file the author changed since your review is viewed
 * when the pull request's file at its path is.
 */
export function useViewedFiles(held: FilesChanged | null) {
  const [store] = useState(() => createViewedFiles(browserStorage()));
  const record = useSyncExternalStore(store.subscribe, store.read);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const pull = held && pullName(held.range.repository, held.pull.number);
  useEffect(() => {
    if (pull !== null) store.look();
  }, [store, pull]);
  const files = held?.read.kind === "ready" ? held.read.files : none;
  const nowOf = (held && sinceShown(held)?.nowOf) ?? null;
  const viewed = useMemo(() => {
    const own = viewedAmong(files, record, pull ?? "");
    if (nowOf === null) return own;
    const again = [...nowOf].flatMap(([since, now]) =>
      now !== null && own.has(now) ? [since] : [],
    );
    return new Set([...own, ...again]);
  }, [files, nowOf, record, pull]);
  return {
    viewed,
    mark: (file: RangeFile, isViewed: boolean) => {
      const now = nowOf?.has(file) ? nowOf.get(file) : file;
      if (pull !== null && now)
        setPersistenceError(store.mark({ pull, mark: markOf(now), isViewed }));
    },
    persistenceError,
  };
}
