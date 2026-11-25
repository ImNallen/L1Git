import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import { z } from "zod";
import type { DiffSteps } from "../components/useDiffSteps";
import type { DiffStyle } from "../domain/lineSelection";
import type { RangeFile } from "../domain/range";
import { createFilesChanged } from "../filesChanged";
import type { FilesChanged } from "../filesChanged";
import { browserStorage, readStored, writeStored } from "../persisted";
import * as repositories from "../repositories";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { OpenedPullRequest } from "./usePullRequests";
import type { ScreenState } from "./useScreen";

const LOOK_KEY = "l1git.filesChanged.v1";
const lookSchema = z.object({
  version: z.literal(1),
  diffStyle: z.enum(["unified", "split"]),
});

export type FilesChangedState = {
  /** Null until the open pull request's tab was opened. */
  held: FilesChanged | null;
  diffStyle: DiffStyle;
  setDiffStyle: (style: DiffStyle) => void;
  go: (at: number) => void;
  showNewest: () => void;
  retry: () => void;
  whole: (file: RangeFile) => Promise<string>;
  ref: RefObject<DiffSteps | null>;
  persistenceError: string | null;
  actions: ActionSlice<
    "filesChanged",
    "nextFile" | "previousFile" | "nextChange" | "previousChange"
  >;
};

/**
 * The Files changed tab of the open pull request. Nothing is read or fetched
 * before that tab is opened, and nothing outlives the pull request's closing.
 */
export function useFilesChanged({
  opened,
  screen: { screen },
}: {
  opened: OpenedPullRequest | null;
  screen: Pick<ScreenState, "screen">;
}): FilesChangedState {
  const [store] = useState(() => createFilesChanged(repositories));
  const latest = useSyncExternalStore(store.subscribe, store.read);
  const [diffStyle, setStyle] = useState<DiffStyle>(
    () =>
      readStored(browserStorage(), LOOK_KEY, lookSchema)?.diffStyle ??
      "unified",
  );
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const ref = useRef<DiffSteps>(null);
  const id = opened?.id ?? null;
  const isShown = opened?.tab === "files";
  const repository = opened?.repository ?? null;
  const pull = opened?.read.value ?? null;
  useEffect(() => {
    const before = store.read()?.of ?? null;
    if (before !== null && before !== id) store.close();
    if (id === null || repository === null || pull === null) return;
    if (isShown || before === id) store.see(id, repository, pull);
  }, [store, id, isShown, repository, pull]);

  const held = latest !== null && latest.of === id ? latest : null;
  const count = held?.read.kind === "ready" ? held.read.files.length : 0;
  const at = held?.at ?? 0;
  const change = (by: 1 | -1) => {
    if (ref.current?.step(by) === true) return;
    store.go(at + by, by === 1 ? "start" : "end");
  };
  return {
    held,
    diffStyle,
    setDiffStyle: (style) => {
      setStyle(style);
      setPersistenceError(
        writeStored(
          browserStorage(),
          LOOK_KEY,
          { version: 1, diffStyle: style },
          "The diff layout changed for this session. Could not save it.",
        ),
      );
    },
    go: store.go,
    showNewest: store.showNewest,
    retry: store.retry,
    whole: store.whole,
    ref,
    persistenceError,
    actions: defineSlice({
      context: {
        filesChanged:
          screen === "pullRequests" && isShown && count > 0
            ? { at, count }
            : null,
      },
      commands: {
        nextFile: () => store.go(at + 1),
        previousFile: () => store.go(at - 1),
        nextChange: () => change(1),
        previousChange: () => change(-1),
      },
    }),
  };
}
