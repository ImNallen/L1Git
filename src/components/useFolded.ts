import { useCallback, useMemo, useState } from "react";
import type { RangeFile } from "../domain/range";

/** Viewed files are folded. A reader can fold and unfold each, until it is marked the other way. */
export function useFolded(
  viewed: ReadonlySet<RangeFile>,
): [
  ReadonlySet<RangeFile>,
  (file: RangeFile) => void,
  (file: RangeFile) => void,
] {
  const [{ of, byHand }, set] = useState<{
    of: ReadonlySet<RangeFile>;
    byHand: ReadonlyMap<RangeFile, boolean>;
  }>({ of: viewed, byHand: new Map() });
  if (of !== viewed)
    set({
      of: viewed,
      byHand: new Map(
        [...byHand].filter(([file]) => of.has(file) === viewed.has(file)),
      ),
    });
  const folded = useMemo(
    () =>
      new Set(
        [...viewed, ...byHand.keys()].filter(
          (file) => byHand.get(file) ?? viewed.has(file),
        ),
      ),
    [viewed, byHand],
  );
  const fold = useCallback(
    (file: RangeFile) =>
      set(({ of, byHand }) => ({
        of,
        byHand: new Map(byHand).set(file, !(byHand.get(file) ?? of.has(file))),
      })),
    [],
  );
  /** Unfolds it, viewed or not, and leaves its mark as it is. */
  const unfold = useCallback(
    (file: RangeFile) =>
      set(({ of, byHand }) => ({
        of,
        byHand: new Map(byHand).set(file, false),
      })),
    [],
  );
  return [folded, fold, unfold];
}
