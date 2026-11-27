import { useEffect, useEffectEvent, useState } from "react";
import type { RefObject } from "react";
import { isInOneHunk } from "../domain/lineComments";
import type { Lines } from "../domain/lineComments";
import type { ReviewThread } from "../domain/pullRequest";
import type { RangeFile } from "../domain/range";
import { isSinceShown, shownFiles, sinceShown } from "../filesChanged";
import type { FilesChanged as Held } from "../filesChanged";
import type { FilesChangedState, FilesView } from "../shell/useFilesChanged";
import type { LinePlace } from "./KeepDiffPlace";
import { ABOVE_CHANGE } from "./useDiffSteps";

/** Where the view goes when it shows another file. */
export type Left = { view: FilesView | null; at: number; line: LinePlace };

const sides = { left: "deletions", right: "additions" } as const;

/** A file, a line of it or a thread, until the view can show it. */
type Destination = {
  path: string;
  line: Omit<LinePlace, "below"> | null;
  names: readonly string[];
};

/**
 * Goes to a file, a line of it or a thread, in either view, unfolding what
 * is named and the file in All files, and to `showing` once the files are
 * read. A file that changed only before your review is in All changes, and
 * so is a line that the since diff doesn't draw.
 */
export function useFilesGoTo({
  held,
  files,
  unfold,
  folded,
  unfoldFile,
  left,
  showing,
  onShown,
}: {
  held: Pick<Held, "read" | "since" | "at" | "patches">;
  files: FilesChangedState;
  unfold: (id: string) => void;
  /** The files All files shows folded, and how to open one. */
  folded: ReadonlySet<RangeFile>;
  unfoldFile: (file: RangeFile) => void;
  left: RefObject<Left | null>;
  showing: ReviewThread | null;
  onShown: () => void;
}) {
  const { read, at, patches, since } = held;
  const [going, goTo] = useState<Destination | null>(null);
  const arrive = useEffectEvent(() => {
    if (going === null || read.kind !== "ready") return;
    const { path, line, names } = going;
    const isAt = (each: RangeFile) => each.path === path || each.from === path;
    const shown = shownFiles(held);
    const to = shown.findIndex(isAt);
    const file = shown[to];
    if (!file && isSinceShown(held) && read.files.some(isAt)) {
      // Until what changed since your review is read, it can't tell whether it has the file.
      if (since?.read.kind === "ready") files.show("all");
      return;
    }
    if (!file) return goTo(null);
    if (
      line !== null &&
      isSinceShown(held) &&
      sinceShown(held)?.nowOf.has(file)
    ) {
      // The since diff draws only new lines, and only in its own hunks, so a
      // line it doesn't draw is shown in All changes.
      if (line.side === "deletions") return files.show("all");
      const patch = patches?.get(file);
      if (patches === null || patch?.kind === "reading") return;
      if (patch === undefined) return files.readFile(file);
      if (
        patch.kind === "ready" &&
        patch.patch.kind === "text" &&
        !isInOneHunk(patch.patch.patch, line.number)
      )
        return files.show("all");
    }
    if (files.view === "all") {
      if (folded.has(file)) return unfoldFile(file);
      // All files draws once every patch was asked for.
      if (patches === null) return;
    }
    goTo(null);
    names.forEach(unfold);
    if (line === null) return files.go(to);
    const patch = patches?.get(file);
    const isDrawn = patch !== undefined && patch.kind !== "reading";
    if (files.view === "all" || (to === at && isDrawn))
      return files.ref.current?.toLine?.(to, line);
    // The file's diff starts there once it draws.
    left.current = {
      view: null,
      at: to,
      line: { ...line, below: ABOVE_CHANGE },
    };
    if (to !== at) files.go(to);
  });
  useEffect(
    () => arrive(),
    [going, read, since, at, patches, folded, files.view],
  );
  /** A pending comment's lines, or, for one of an older commit, its file's
   * other comments. */
  const goToLines = ({ path, side, line }: Lines, isOlder: boolean) =>
    goTo({
      path,
      line: isOlder ? null : { part: 0, side: sides[side], number: line },
      names: isOlder ? [`elsewhere ${path}`] : [],
    });
  /** Its line, unfolded there, or its file's other threads. */
  const openThread = (thread: ReviewThread) => {
    const isOnLine = thread.line !== null && !thread.outdated;
    goTo({
      path: thread.path,
      line:
        isOnLine && thread.line !== null
          ? { part: 0, side: sides[thread.side], number: thread.line }
          : null,
      names: isOnLine ? [thread.id] : [`elsewhere ${thread.path}`],
    });
  };
  const show = useEffectEvent(() => {
    if (showing === null) return;
    openThread(showing);
    onShown();
  });
  useEffect(() => show(), [showing]);
  return { goToLines, openThread };
}
