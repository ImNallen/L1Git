import {
  use,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Ref, RefObject } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { CodeView as Viewer } from "@pierre/diffs/react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { sidesFor } from "../domain/fileSides";
import type { DiffStyle } from "../domain/lineSelection";
import type { ReviewThread } from "../domain/pullRequest";
import type { RangeFile } from "../domain/range";
import type { FilesChanged } from "../filesChanged";
import allFilesStyles from "../styles/allFilesPatch.css?inline";
import { AllFilesKeeper, HEADER, layout } from "./allFilesKeeper";
import { keyExpanders } from "./expanders";
import { EndOfEach, holdEnd } from "./FileEnd";
import { FileHeader, OverLines } from "./FileNotes";
import { ReadingFiles } from "./FilesState";
import { KeepAllFilesPlace } from "./KeepAllFilesPlace";
import type { LinePlace } from "./KeepDiffPlace";
import { patchOptions } from "./patchOptions";
import { SurroundingsContext } from "./pullRequestText";
import { ThreadChips } from "./ReviewThreads";
import type { Unfolded } from "./ReviewThreads";
import { hasSelection } from "./selection";
import { tabIntoView } from "./tabIntoView";
import { Turns, TurnsContext } from "./turns";
import { reviewMetrics } from "./useDiffSteps";
import type { DiffSteps } from "./useDiffSteps";
import { entryId, fileOfDiff, useFileItems } from "./useFileItems";
import type { FileNote } from "./useFileItems";
import { useRedraws } from "./useRedraws";
import { useSteady } from "./useSteady";

/** As the stylesheets have it. */
const END = 48;
/** Above this many lines, a file is drawn without colors, which takes Pierre too long. */
const MOST_COLORED = 3_000;

/** Every file of a pull request, one after the other. */
export function AllFiles({
  ref,
  pane,
  holdsFocus,
  startsAt,
  files,
  contentMissing,
  patches,
  at,
  threads: newest,
  unfolded,
  viewed,
  onMark,
  folded,
  onFold,
  isShown,
  diffStyle,
  viewer: login,
  url,
  whole,
  onAt,
  onRead,
  onReadAgain,
  onLeave,
}: {
  ref: Ref<DiffSteps>;
  pane: RefObject<HTMLElement | null>;
  holdsFocus: RefObject<boolean>;
  /** Where in the current file to begin, or null for its beginning. */
  startsAt: () => LinePlace | null;
  files: readonly RangeFile[];
  contentMissing: boolean;
  patches: FilesChanged["patches"];
  at: number;
  threads: ReadonlyMap<RangeFile, readonly ReviewThread[]>;
  unfolded: Unfolded;
  viewed: ReadonlySet<RangeFile>;
  onMark: (file: RangeFile, isViewed: boolean) => void;
  folded: ReadonlySet<RangeFile>;
  onFold: (file: RangeFile) => void;
  isShown: boolean;
  diffStyle: DiffStyle;
  viewer: string;
  url: string;
  whole: (file: RangeFile) => Promise<string>;
  onAt: (at: number) => void;
  onRead: (file: RangeFile) => void;
  onReadAgain: (file: RangeFile) => void;
  onLeave: (at: number, place: LinePlace) => void;
}) {
  const { theme, painted } = use(SurroundingsContext);
  const [turns] = useState(() => new Turns());
  const scroller = useRef<HTMLDivElement>(null);
  const handle = useRef<CodeViewHandle<FileNote, undefined>>(null);
  const viewer = useCallback(() => handle.current?.getInstance(), []);
  const isSelected = useCallback(
    () => scroller.current !== null && hasSelection(scroller.current),
    [],
  );
  const threads = useSteady(newest, isSelected);
  const { items, entries, count } = useFileItems(
    files,
    patches,
    contentMissing,
    threads,
    folded,
  );
  const [begins] = useState(at);
  const isReady = count > begins;

  const [appearances, setAppearances] = useState(0);
  const drawn = useRedraws();
  const latestWhole = useRef(whole);
  latestWhole.current = whole;
  const options = useMemo(() => {
    const shared = patchOptions(theme, painted);
    return {
      ...shared,
      unsafeCSS: `${shared.unsafeCSS}\n${allFilesStyles}`,
      diffStyle,
      diffIndicators: "classic",
      hunkSeparators: "line-info-basic",
      stickyHeaders: true,
      pointerEventsOnScroll: true,
      tokenizeMaxLength: MOST_COLORED,
      layout,
      itemMetrics: {
        ...reviewMetrics,
        diffHeaderHeight: HEADER,
        paddingBottom: END,
        // Other metrics that mean the same make Pierre measure all anew.
        ...(appearances % 2 === 1 && { hunkSeparatorHeight: undefined }),
      },
      onPostRender: (node: HTMLElement) => {
        keyExpanders(node);
        holdEnd(node);
        drawn(node);
      },
      loadDiffFiles: async (diff: FileDiffMetadata) => {
        const file = fileOfDiff(diff);
        if (!file) throw new Error("The diff is of no file.");
        return sidesFor(diff, await latestWhole.current(file));
      },
    } as const;
  }, [theme, painted, diffStyle, appearances, drawn]);

  const known = { entries, folded, contentMissing, onAt, onRead };
  const [keeper] = useState(() => new AllFilesKeeper(viewer, known));
  useLayoutEffect(() => keeper.update(known));
  useEffect(() => () => keeper.stop(), [keeper]);
  useLayoutEffect(
    function goToCurrent() {
      if (isReady) keeper.goTo(at);
    },
    [keeper, isReady, entries, at],
  );
  const latestStart = useRef(startsAt);
  useLayoutEffect(
    function goToStart() {
      const line = isReady ? latestStart.current() : null;
      if (!line) return;
      const { part, side, number, below } = line;
      const id = entryId(begins, part);
      keeper.put({ id, line: { side, number }, below }, begins);
    },
    [isReady, keeper, begins],
  );
  const leave = () => {
    keeper.tell();
    const place = keeper.hereInFile();
    const entry = place && entries.get(place.id);
    if (entry && place.line)
      onLeave(entry.at, {
        ...place.line,
        part: entry.part,
        below: place.below,
      });
  };
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    root.tabIndex = 0;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "All changed files");
    const scrolls = ["wheel", "touchmove"];
    for (const event of scrolls)
      root.addEventListener(event, keeper.free, { passive: true });
    const touch = ({ target }: Event) => {
      // A note tells more.
      if (target instanceof Element && target.closest(".files-annotation"))
        return;
      keeper.touch();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") touch(event);
      tabIntoView(event);
    };
    root.addEventListener("pointerdown", touch);
    root.addEventListener("keydown", onKey);
    if (holdsFocus.current || document.activeElement === pane.current)
      root.focus({ preventScroll: true });
    holdsFocus.current = false;
    return () => {
      for (const event of scrolls) root.removeEventListener(event, keeper.free);
      root.removeEventListener("pointerdown", touch);
      root.removeEventListener("keydown", onKey);
      holdsFocus.current = root.contains(document.activeElement);
    };
  }, [isReady, pane, holdsFocus, keeper]);

  const beforeMark = (file: RangeFile, isViewed: boolean) => {
    // Its button goes away, and the focus would go with it.
    const was = document.activeElement;
    if (isViewed && was?.closest(".files-end"))
      scroller.current?.focus({ preventScroll: true });
    if (isViewed && was?.closest(".files-annotation"))
      was
        .closest("diffs-container")
        ?.querySelector<HTMLElement>(".files-header > button")
        ?.focus({ preventScroll: true });
    const { activeElement: focused } = document;
    const isFocusSeen =
      focused?.matches(".files-header :focus-visible") === true;
    keeper.beforeMark(
      files.indexOf(file),
      isViewed,
      isFocusSeen ? focused : null,
    );
  };
  useImperativeHandle(ref, () => ({
    step: (by) => {
      keeper.step(by);
      return true;
    },
    toStart: (of) => keeper.toStart(of),
    tell: keeper.tell,
    beforeMark,
  }));

  if (!isReady) return <ReadingFiles />;
  return (
    <TurnsContext value={turns}>
      <KeepAllFilesPlace
        keeper={keeper}
        items={items}
        isShown={isShown}
        onAppear={() => setAppearances((before) => before + 1)}
        onLeave={leave}
      />
      <div className="file-diff-body files-body">
        <Viewer<FileNote>
          ref={handle}
          containerRef={scroller}
          className="file-diff-scroll files-all-scroll"
          items={items}
          options={options}
          onScroll={keeper.onScroll}
          renderCustomHeader={({ id }) => {
            const entry = entries.get(id);
            if (!entry) return undefined;
            const { file, part, parts } = entry;
            const isFolded = folded.has(file);
            const marking = {
              isCurrent: entry.at === at,
              isViewed: viewed.has(file),
              onMark: (isViewed: boolean) => onMark(file, isViewed),
            };
            return (
              <>
                <FileHeader
                  {...marking}
                  entry={entry}
                  folded={isFolded}
                  onFold={() => {
                    keeper.beforeFold(id);
                    onFold(file);
                  }}
                />
                {!isFolded && part + 1 >= parts && (
                  <EndOfEach file={file} {...marking} />
                )}
              </>
            );
          }}
          renderAnnotation={(...[note, , { id }]) => {
            const entry = entries.get(id);
            if (!entry) return null;
            const { metadata, lineNumber: number } = note;
            const line =
              "side" in note && number > 0 ? { side: note.side, number } : null;
            const touch = () => keeper.touchAfter({ id, line });
            return (
              <div
                className="files-annotation"
                onPointerDownCapture={touch}
                onKeyDownCapture={({ key }) => {
                  if (key === "Enter" || key === " ") touch();
                }}
              >
                {metadata === "file" ? (
                  <OverLines
                    entry={entry}
                    contentMissing={contentMissing}
                    viewer={login}
                    url={url}
                    unfolded={unfolded}
                    onRead={onRead}
                    onReadAgain={(file) => {
                      keeper.beforeRead(entry.at);
                      onReadAgain(file);
                    }}
                  />
                ) : (
                  <ThreadChips
                    ids={metadata}
                    threads={threads.get(entry.file) ?? []}
                    viewer={login}
                    url={url}
                    unfolded={unfolded}
                  />
                )}
              </div>
            );
          }}
        />
      </div>
    </TurnsContext>
  );
}
