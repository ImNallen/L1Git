import { useEffect, useEffectEvent } from "react";
import type { RefObject } from "react";
import type { Lines } from "../domain/lineComments";
import type { ReviewThread } from "../domain/pullRequest";
import type { FilesChanged as Held } from "../filesChanged";
import type { FilesChangedState, FilesView } from "../shell/useFilesChanged";
import type { LinePlace } from "./KeepDiffPlace";
import { ABOVE_CHANGE } from "./useDiffSteps";

/** Where the view goes when it shows another file. */
export type Left = { view: FilesView | null; at: number; line: LinePlace };

const sides = { left: "deletions", right: "additions" } as const;

/**
 * Goes to a file, a line of it or a thread, in either view, unfolding what
 * is named, and to `showing` once the files are read.
 */
export function useFilesGoTo({
  held: { read, at },
  files,
  unfold,
  left,
  showing,
  onShown,
}: {
  held: Held;
  files: FilesChangedState;
  unfold: (id: string) => void;
  left: RefObject<Left | null>;
  showing: ReviewThread | null;
  onShown: () => void;
}) {
  const goTo = (
    path: string,
    line: Omit<LinePlace, "below"> | null,
    names: readonly string[],
  ) => {
    if (read.kind !== "ready") return;
    const to = read.files.findIndex(
      (each) => each.path === path || each.from === path,
    );
    if (to < 0) return;
    names.forEach(unfold);
    if (line === null) return files.go(to);
    if (files.view === "all" || to === at)
      files.ref.current?.toLine?.(to, line);
    else {
      left.current = {
        view: null,
        at: to,
        line: { ...line, below: ABOVE_CHANGE },
      };
      files.go(to);
    }
  };
  /** A pending comment's lines, or, for one of an older commit, its file's
   * other comments. */
  const goToLines = ({ path, side, line }: Lines, isOlder: boolean) =>
    goTo(
      path,
      isOlder ? null : { part: 0, side: sides[side], number: line },
      isOlder ? [`elsewhere ${path}`] : [],
    );
  /** Its line, unfolded there, or its file's other threads. */
  const openThread = (thread: ReviewThread) => {
    const isOnLine = thread.line !== null && !thread.outdated;
    goTo(
      thread.path,
      isOnLine && thread.line !== null
        ? { part: 0, side: sides[thread.side], number: thread.line }
        : null,
      isOnLine ? [thread.id] : [`elsewhere ${thread.path}`],
    );
  };
  const show = useEffectEvent(() => {
    if (showing === null || read.kind !== "ready") return;
    openThread(showing);
    onShown();
  });
  useEffect(() => show(), [showing, read.kind]);
  return { goToLines, openThread };
}
