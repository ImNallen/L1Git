import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RangeFile } from "../domain/range";
import { markOf, pullName, viewedAmong } from "../domain/viewedFiles";
import type { FilesChanged } from "../filesChanged";
import { browserStorage } from "../persisted";
import { createViewedFiles } from "../viewedFiles";

const none: readonly RangeFile[] = [];

/** Which files of the Files changed tab are viewed. */
export function useViewedFiles(held: FilesChanged | null) {
  const [store] = useState(() => createViewedFiles(browserStorage()));
  const record = useSyncExternalStore(store.subscribe, store.read);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const pull = held && pullName(held.range.repository, held.pull.number);
  useEffect(() => {
    if (pull !== null) store.look();
  }, [store, pull]);
  const files = held?.read.kind === "ready" ? held.read.files : none;
  const viewed = useMemo(
    () => viewedAmong(files, record, pull ?? ""),
    [files, record, pull],
  );
  return {
    viewed,
    mark: (file: RangeFile, isViewed: boolean) => {
      if (pull !== null)
        setPersistenceError(store.mark({ pull, mark: markOf(file), isViewed }));
    },
    persistenceError,
  };
}
