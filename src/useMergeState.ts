import { useCallback, useEffect, useRef, useState } from "react";
import { mergeState } from "./repositories";
import { problemFrom } from "./domain/repository";
import type { RepositoryRoot } from "./domain/repository";
import type { MergeState } from "./domain/merge";
import type { Read } from "./useRead";

export function useMergeState(
  root: RepositoryRoot | null,
  refreshSignal: unknown,
) {
  const sequence = useRef(0);
  const [state, setState] = useState<{
    root: RepositoryRoot;
    read: Read<MergeState>;
  } | null>(null);
  const refresh = useCallback(async () => {
    const token = ++sequence.current;
    if (root === null) return;
    let read: Read<MergeState>;
    try {
      read = { kind: "ready", value: await mergeState(root) };
    } catch (error) {
      read = { kind: "error", error: problemFrom(error) };
    }
    if (sequence.current === token) setState({ root, read });
  }, [root]);
  useEffect(() => {
    void refresh();
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- a sequence counter, not a DOM ref; bumping the live value drops in-flight reads
      sequence.current++;
    };
  }, [refresh, refreshSignal]);
  const read: Read<MergeState> =
    state?.root === root && state !== null ? state.read : { kind: "loading" };
  return [read, refresh] as const;
}
