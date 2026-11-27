import { use, useCallback, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode, Ref, RefObject } from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import { FileX2 } from "lucide-react";
import {
  inPlaceOfLines,
  modeChange,
  partialClone,
  shownPath,
} from "../domain/filesChanged";
import { placeOf, rangeOf } from "../domain/lineComments";
import type { LineAnchor } from "../domain/lineComments";
import { parsedFiles } from "../domain/lineSelection";
import type { DiffStyle } from "../domain/lineSelection";
import type { ReviewThread } from "../domain/pullRequest";
import type { RangeFile } from "../domain/range";
import type { Oid } from "../domain/repository";
import { placeNotes } from "../domain/reviewThreads";
import type { LineNote, NotesOnLine } from "../domain/reviewThreads";
import type { FilesChanged, PatchRead } from "../filesChanged";
import { Diff } from "./FilePatchView";
import { Moved } from "./FileParts";
import { FilesState, ReadingFiles } from "./FilesState";
import type { LinePlace } from "./KeepDiffPlace";
import { SurroundingsContext } from "./pullRequestText";
import { LineNoteView } from "./LineComments";
import { ThreadsElsewhere } from "./ReviewThreads";
import type { Unfolded } from "./ReviewThreads";
import { LineCommentsContext, noNotes } from "./useLineComments";
import { hasSelection } from "./selection";
import { Turns, TurnsContext } from "./turns";
import type { DiffSteps } from "./useDiffSteps";
import { useSteady } from "./useSteady";

/** A file without lines to draw, in the place where its lines would scroll. */
function Lineless({
  above,
  below,
  children,
}: {
  above: ReactNode;
  below: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="file-diff-body">
      <div className="file-diff-scroll files-lineless">
        {above}
        {children}
        {below}
      </div>
    </div>
  );
}

/** One file of a pull request. It is another one, with a place of its own, for each file. */
export function FileChanged({
  ref,
  pane,
  holdsFocus,
  file,
  enter,
  startsAt,
  head,
  patch,
  contentMissing,
  threads: newest,
  isSince,
  refusal,
  unfolded,
  isShown,
  diffStyle,
  viewer,
  url,
  whole,
  onRetry,
  below,
  onLeave,
}: {
  ref: Ref<DiffSteps>;
  pane: RefObject<HTMLElement | null>;
  /** Whether the file before had the focus, which is this one's then. */
  holdsFocus: RefObject<boolean>;
  file: RangeFile;
  enter: FilesChanged["enter"];
  startsAt: () => LinePlace | null;
  /** The head of what is shown. */
  head: Oid;
  /** Null until it was asked for. */
  patch: PatchRead | null;
  contentMissing: boolean;
  threads: readonly ReviewThread[];
  /** Whether it is of what changed since your review, whose old side GitHub has never seen. */
  isSince: boolean;
  /** Why chosen lines take no comment, or null when they take one. */
  refusal: (anchor: LineAnchor) => string | null;
  unfolded: Unfolded;
  isShown: boolean;
  diffStyle: DiffStyle;
  viewer: string;
  url: string;
  whole: () => Promise<string>;
  onRetry: () => void;
  /** At the end of the file. */
  below: ReactNode;
  onLeave: (place: LinePlace) => void;
}) {
  const { theme, painted } = use(SurroundingsContext);
  const [turns] = useState(() => new Turns());
  const comments = use(LineCommentsContext);
  const notes = comments?.notesOf(file) ?? noNotes;
  const isBoxOpen = notes.box !== null;
  const isSelected = useCallback(
    () => isBoxOpen || (pane.current !== null && hasSelection(pane.current)),
    [pane, isBoxOpen],
  );
  // Pierre draws every line again for other threads, and a selection is lost.
  const threads = useSteady(newest, isSelected);
  const diff = patch?.kind === "ready" ? patch.patch : null;
  const words = diff && inPlaceOfLines(file, diff);
  const lines = words === null && diff?.kind === "text" ? diff.patch : null;
  const { onLines, elsewhere } = useMemo(
    () =>
      placeNotes(
        { threads, ...notes },
        head,
        lines === null ? [] : parsedFiles(lines),
        { left: !isSince },
      ),
    [threads, notes, head, lines, isSince],
  );
  const places = JSON.stringify(onLines);
  // Pierre draws every line again for another list, and drops a selection.
  const steadyPlaces = useMemo(
    () => JSON.parse(places) as NotesOnLine[][],
    [places],
  );
  const renderNote = useCallback(
    (note: LineNote) => (
      <LineNoteView
        note={note}
        threads={threads}
        viewer={viewer}
        url={url}
        unfolded={unfolded}
      />
    ),
    [threads, viewer, url, unfolded],
  );
  const boxPart = steadyPlaces.findIndex((part) =>
    part.some(({ metadata }) => metadata.box),
  );
  const boxLines = notes.box && JSON.stringify(notes.box.anchor);
  const chosen = useMemo(
    () =>
      boxLines === null || boxPart < 0
        ? null
        : { part: boxPart, range: rangeOf(JSON.parse(boxLines)) },
    [boxPart, boxLines],
  );
  const choose = (part: number, range: SelectedLineRange) => {
    const shown = lines === null ? undefined : parsedFiles(lines)[part];
    const anchor = shown && placeOf(shown, diffStyle, file.path, range);
    const refused = anchor && refusal(anchor);
    if (anchor && !refused) comments?.open(anchor);
    else comments?.refuseLines(refused ?? undefined);
  };
  useLayoutEffect(() => {
    const scroller =
      pane.current?.querySelector<HTMLElement>(".file-diff-scroll");
    if (!scroller) return;
    // Pierre makes the one of a diff, and takes no attributes for it.
    scroller.tabIndex = 0;
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", shownPath(file.path));
    if (!holdsFocus.current && document.activeElement !== pane.current) return;
    holdsFocus.current = false;
    scroller.focus({ preventScroll: true });
  });
  useLayoutEffect(() => {
    if (holdsFocus.current) pane.current?.focus({ preventScroll: true });
  }, [pane, holdsFocus]);
  const hasFocus = useCallback(() => {
    const focused = document.activeElement;
    return (
      focused !== null &&
      (focused === pane.current || focused.closest(".files-body") !== null)
    );
  }, [pane]);
  useLayoutEffect(
    () => () => {
      holdsFocus.current = hasFocus();
    },
    [holdsFocus, hasFocus],
  );

  const above = (elsewhere.threads.length > 0 ||
    elsewhere.drafts.length > 0 ||
    elsewhere.sent.length > 0) && (
    <ThreadsElsewhere
      path={file.path}
      elsewhere={elsewhere}
      viewer={viewer}
      url={url}
      unfolded={unfolded}
    />
  );
  const body = () => {
    if (contentMissing)
      return (
        <Lineless above={above} below={below}>
          <FilesState title={partialClone} url={url} />
        </Lineless>
      );
    if (patch?.kind === "failed")
      return (
        <Lineless above={above} below={below}>
          <FilesState
            title="Couldn't read this file's changes"
            url={url}
            onRetry={onRetry}
          >
            <p role="alert">{patch.problem.message}</p>
          </FilesState>
        </Lineless>
      );
    if (diff === null) return <ReadingFiles />;
    if (words !== null)
      return (
        <Lineless above={above} below={below}>
          <div className="file-diff-empty">
            <FileX2 size={28} aria-hidden="true" />
            <p>{words}</p>
          </div>
        </Lineless>
      );
    return (
      <Diff
        diff={diff}
        whole={whole}
        diffStyle={diffStyle}
        theme={theme}
        painted={painted}
        review={{
          ref,
          startsAtEnd: enter === "end",
          startsAt,
          onLeave,
          isShown,
          above,
          below,
          onLines: steadyPlaces,
          renderNote,
          chosen,
          onChoose: choose,
        }}
      />
    );
  };
  return (
    <TurnsContext value={turns}>
      <Moved
        file={file}
        mode={lines === null || !diff ? null : modeChange(diff)}
      />
      <div className="files-body">{body()}</div>
    </TurnsContext>
  );
}
