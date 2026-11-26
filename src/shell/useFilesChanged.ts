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
import { useViewedFiles } from "./useViewedFiles";

const LOOK_KEY = "l1git.filesChanged.v1";
const lookSchema = z.object({
  version: z.literal(1),
  diffStyle: z.enum(["unified", "split"]),
  view: z.enum(["one", "all"]).default("one"),
});
type Look = Omit<z.infer<typeof lookSchema>, "version">;
/** Whether one file shows at a time, or each after the other. */
export type FilesView = Look["view"];

export type FilesChangedState = {
  /** Null until the open pull request's tab was opened. */
  held: FilesChanged | null;
  diffStyle: DiffStyle;
  view: FilesView;
  setLook: (look: Partial<Look>) => void;
  viewed: ReadonlySet<RangeFile>;
  mark: (file: RangeFile, isViewed: boolean) => void;
  go: (at: number) => void;
  /** As `go`, and back to its beginning when it is the current one. */
  choose: (at: number) => void;
  showNewest: () => void;
  retry: () => void;
  readFile: (file: RangeFile) => void;
  readFileAgain: (file: RangeFile) => void;
  whole: (file: RangeFile) => Promise<string>;
  ref: RefObject<DiffSteps | null>;
  persistenceError: string | null;
  actions: ActionSlice<
    "filesChanged",
    | "nextFile"
    | "previousFile"
    | "nextChange"
    | "previousChange"
    | "toggleViewed"
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
  const [{ diffStyle, view }, setLook] = useState<Look>(
    () =>
      readStored(browserStorage(), LOOK_KEY, lookSchema) ?? {
        diffStyle: "unified",
        view: "one",
      },
  );
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const ref = useRef<DiffSteps>(null);
  const id = opened?.id ?? null;
  const isShown = opened?.tab === "files";
  const repository = opened?.repository ?? null;
  const pull = opened?.read.value ?? null;
  const isComing = opened?.isComing === true;
  useEffect(() => {
    const before = store.read()?.of ?? null;
    if (before !== null && before !== id) store.close();
    if (id === null || repository === null || pull === null) return;
    if (isShown || before === id) store.see(id, repository, pull, isComing);
  }, [store, id, isShown, repository, pull, isComing]);

  const held = latest !== null && latest.of === id ? latest : null;
  const { viewed, ...marks } = useViewedFiles(held);
  const files = held?.read.kind === "ready" ? held.read.files : [];
  const count = files.length;
  const at = held?.at ?? 0;
  /** The current file as it is when a key is pressed. */
  const now = () => {
    ref.current?.tell?.();
    return store.read()?.at ?? 0;
  };
  const file = files[at];
  const isViewed = file !== undefined && viewed.has(file);
  const mark = (of: RangeFile, next: boolean) => {
    ref.current?.beforeMark?.(of, next);
    marks.mark(of, next);
  };
  const change = (by: 1 | -1) => {
    if (ref.current?.step(by) === true) return;
    store.go(now() + by, by === 1 ? "start" : "end");
  };
  return {
    held,
    diffStyle,
    view,
    setLook: (look) => {
      const next = { diffStyle, view, ...look };
      setLook(next);
      setPersistenceError(
        writeStored(
          browserStorage(),
          LOOK_KEY,
          { version: 1, ...next },
          "The diff layout changed for this session. Could not save it.",
        ),
      );
    },
    viewed,
    mark,
    go: store.go,
    choose: (to) => {
      if (to === now()) ref.current?.toStart(to);
      else store.go(to);
    },
    showNewest: store.showNewest,
    retry: store.retry,
    readFile: store.readFile,
    readFileAgain: store.readFileAgain,
    whole: store.whole,
    ref,
    persistenceError: persistenceError ?? marks.persistenceError,
    actions: defineSlice({
      context: {
        filesChanged:
          screen === "pullRequests" && isShown && count > 0
            ? { at, count, isViewed }
            : null,
      },
      commands: {
        nextFile: () => store.go(now() + 1),
        previousFile: () => store.go(now() - 1),
        nextChange: () => change(1),
        previousChange: () => change(-1),
        toggleViewed: () => {
          const current = files[now()];
          if (current) mark(current, !viewed.has(current));
        },
      },
    }),
  };
}
