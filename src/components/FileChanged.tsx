import { use, useCallback, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode, Ref, RefObject } from "react";
import { ChevronRight, FileX2 } from "lucide-react";
import { inPlaceOfLines } from "../domain/filesChanged";
import { parsedFiles } from "../domain/lineSelection";
import type { DiffStyle } from "../domain/lineSelection";
import type { ReviewThread } from "../domain/pullRequest";
import type { RangeFile } from "../domain/range";
import { placeThreads } from "../domain/reviewThreads";
import type { ThreadsOnLine } from "../domain/reviewThreads";
import type { FilesChanged, PatchRead } from "../filesChanged";
import { Diff } from "./FilePatchView";
import { FilesState, ReadingFiles } from "./FilesState";
import { SurroundingsContext } from "./pullRequestText";
import { ThreadChip, ThreadsElsewhere } from "./ReviewThreads";
import { Turns, TurnsContext } from "./turns";
import type { DiffSteps } from "./useDiffSteps";

function MovedFrom({ file: { from, similarity } }: { file: RangeFile }) {
  if (from === null) return null;
  return (
    <p className="files-moved">
      Moved from{" "}
      <code>
        <bdi>{from}</bdi>
      </code>
      {similarity !== null && similarity < 100 && (
        <span> · {similarity}% the same.</span>
      )}
    </p>
  );
}

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

export type Unfolded = {
  threads: ReadonlySet<string>;
  toggle: (thread: string) => void;
};

/** One file of a pull request. It is another one, with a place of its own, for each file. */
export function FileChanged({
  ref,
  pane,
  holdsFocus,
  file,
  enter,
  patch,
  contentMissing,
  threads,
  unfolded,
  isShown,
  diffStyle,
  viewer,
  url,
  whole,
  onRetry,
  onNext,
}: {
  ref: Ref<DiffSteps>;
  pane: RefObject<HTMLElement | null>;
  /** Whether the file before had the focus, which is this one's then. */
  holdsFocus: RefObject<boolean>;
  file: RangeFile;
  enter: FilesChanged["enter"];
  /** Null until it was asked for. */
  patch: PatchRead | null;
  contentMissing: boolean;
  threads: readonly ReviewThread[];
  unfolded: Unfolded;
  isShown: boolean;
  diffStyle: DiffStyle;
  viewer: string;
  url: string;
  whole: () => Promise<string>;
  onRetry: () => void;
  onNext: (() => void) | null;
}) {
  const { theme, painted } = use(SurroundingsContext);
  const [turns] = useState(() => new Turns());
  const diff = patch?.kind === "ready" ? patch.patch : null;
  const words = diff && inPlaceOfLines(file, diff);
  const lines = words === null && diff?.kind === "text" ? diff.patch : null;
  const { onLines, elsewhere } = useMemo(
    () => placeThreads(threads, lines === null ? [] : parsedFiles(lines)),
    [threads, lines],
  );
  const places = JSON.stringify(onLines);
  // Pierre draws every line again for another list, and drops a selection.
  const steadyPlaces = useMemo(
    () => JSON.parse(places) as ThreadsOnLine[][],
    [places],
  );
  const renderThreads = useCallback(
    (ids: readonly string[]) => (
      <div className="thread-chips">
        {threads
          .filter(({ id }) => ids.includes(id))
          .map((thread) => (
            <ThreadChip
              key={thread.id}
              thread={thread}
              viewer={viewer}
              url={url}
              open={unfolded.threads.has(thread.id)}
              onToggle={unfolded.toggle}
            />
          ))}
      </div>
    ),
    [threads, viewer, url, unfolded],
  );
  useLayoutEffect(() => {
    const scroller =
      pane.current?.querySelector<HTMLElement>(".file-diff-scroll");
    if (!scroller) return;
    // Pierre makes the one of a diff, and takes no attributes for it.
    scroller.tabIndex = 0;
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", file.path);
    if (!holdsFocus.current) return;
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

  const above = elsewhere.length > 0 && (
    <ThreadsElsewhere threads={elsewhere} viewer={viewer} url={url} />
  );
  const below = onNext && (
    <div className="files-next">
      <button
        type="button"
        className="button secondary"
        title="Next file (J)"
        onClick={onNext}
      >
        Next file
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
  const body = () => {
    if (contentMissing)
      return (
        <Lineless above={above} below={below}>
          <FilesState
            title="This is a partial clone, and file contents aren't on this computer."
            url={url}
          />
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
          isShown,
          above,
          below,
          onLines: steadyPlaces,
          renderThreads,
        }}
      />
    );
  };
  return (
    <TurnsContext value={turns}>
      <MovedFrom file={file} />
      <div className="files-body">{body()}</div>
    </TurnsContext>
  );
}
