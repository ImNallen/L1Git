import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RangeFile } from "../domain/range";
import { carried } from "../domain/sinceReview";
import { markOf, pullName, viewedAmong } from "../domain/viewedFiles";
import type { MarkChange } from "../domain/viewedFiles";
import { sinceShown } from "../filesChanged";
import type { FilesChanged } from "../filesChanged";
import { browserStorage } from "../persisted";
import { createViewedFiles } from "../viewedFiles";

const none: readonly RangeFile[] = [];

/**
 * Which files of the Files changed tab are viewed. A mark is the pull
 * request's file's, so a file the author changed since your review is viewed
 * when the pull request's file at its path is. A file that only the base's
 * changes moved since your review keeps the mark you gave it.
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
  const shown = held && sinceShown(held);
  const nowOf = shown?.nowOf ?? null;
  const rebased = shown?.groups.rebased ?? null;
  useEffect(() => {
    if (pull === null || rebased === null) return;
    const changes = carried(pull, rebased, store.read());
    if (changes.length > 0) setPersistenceError(store.mark(changes));
  }, [store, pull, rebased]);
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
    /** Unmarking a file only the base's changes moved unmarks it as you reviewed it too, so it is not carried again. */
    mark: (file: RangeFile, isViewed: boolean) => {
      const now = nowOf?.has(file) ? nowOf.get(file) : file;
      if (pull === null || !now) return;
      const before = isViewed
        ? null
        : (rebased?.find((each) => each.now === now)?.reviewed ?? null);
      const changes: MarkChange[] = [{ pull, mark: markOf(now), isViewed }];
      if (before) changes.push({ pull, mark: markOf(before), isViewed });
      setPersistenceError(store.mark(changes));
    },
    persistenceError,
  };
}
