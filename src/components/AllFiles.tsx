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
import type { CodeView, FileDiffMetadata } from "@pierre/diffs";
import { CodeView as Viewer } from "@pierre/diffs/react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { changeStops, nextChange } from "../domain/changeStops";
import { sidesFor } from "../domain/fileSides";
import type { DiffStyle } from "../domain/lineSelection";
import type { ReviewThread } from "../domain/pullRequest";
import type { RangeFile } from "../domain/range";
import type { FilesChanged } from "../filesChanged";
import allFilesStyles from "../styles/allFilesPatch.css?inline";
import { keyExpanders } from "./expanders";
import { FileHeader, OverLines } from "./FileNotes";
import { ReadingFiles } from "./FilesState";
import { KeepAllFilesPlace, scrollToPlace } from "./KeepAllFilesPlace";
import type { AllFilesPlace } from "./KeepAllFilesPlace";
import type { LinePlace } from "./KeepDiffPlace";
import { patchOptions } from "./patchOptions";
import { SurroundingsContext } from "./pullRequestText";
import { ThreadChips } from "./ReviewThreads";
import type { Unfolded } from "./ReviewThreads";
import { hasSelection } from "./selection";
import { Turns, TurnsContext } from "./turns";
import { ABOVE_CHANGE, reviewMetrics } from "./useDiffSteps";
import type { DiffSteps } from "./useDiffSteps";
import { entryId, fileOfDiff, useFileItems } from "./useFileItems";
import type { FileEntry, FileNote } from "./useFileItems";
import { useSteady } from "./useSteady";

/** As the stylesheet has it. */
const HEADER = 40;
/** Above this many lines, a file is drawn without colors, which takes Pierre too long. */
const MOST_COLORED = 3_000;
const REPORT_MS = 100;
const HELD_FRAMES = 20;
const layout = { paddingTop: 0, paddingBottom: 64, gap: 0 };

/** What a step went to. It is current until the reader scrolls. */
type Goal = { id: string } | null;

/** The one whose header is pinned. */
const pinned = (viewer: CodeView<FileNote>) =>
  viewer
    .getRenderedItems()
    .findLast(
      ({ id }) =>
        (viewer.getTopForItem(id) ?? Infinity) <= viewer.getScrollTop() + 1,
    )?.id;

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
        // Other metrics that mean the same make Pierre measure all anew.
        ...(appearances % 2 === 1 && { hunkSeparatorHeight: undefined }),
      },
      onPostRender: (node: HTMLElement) => keyExpanders(node),
      loadDiffFiles: async (diff: FileDiffMetadata) => {
        const file = fileOfDiff(diff);
        if (!file) throw new Error("The diff is of no file.");
        return sidesFor(diff, await latestWhole.current(file));
      },
    } as const;
  }, [theme, painted, diffStyle, appearances]);

  const shownAt = useRef(0);
  const goal = useRef<Goal>(null);
  const holding = useRef(0);
  const timer = useRef(0);
  const report = useCallback(() => {
    const instance = viewer();
    timer.current = 0;
    if (!instance || goal.current !== null) return;
    if ((scroller.current?.clientHeight ?? 0) === 0) return;
    const current = pinned(instance);
    const now = current === undefined ? undefined : entries.get(current)?.at;
    if (now === undefined || now === shownAt.current) return;
    shownAt.current = now;
    onAt(now);
  }, [viewer, entries, onAt]);
  const latestReport = useRef(report);
  latestReport.current = report;
  const onScroll = useCallback(() => {
    if (timer.current === 0)
      timer.current = window.setTimeout(
        () => latestReport.current(),
        REPORT_MS,
      );
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(function beginAtTop() {
    shownAt.current = 0;
    goal.current = null;
  }, []);
  useLayoutEffect(
    function goToCurrent() {
      const instance = viewer();
      if (!isReady || !instance || at === shownAt.current) return;
      if (!entries.has(entryId(at))) return;
      cancelAnimationFrame(holding.current);
      shownAt.current = at;
      goal.current = { id: entryId(at) };
      instance.scrollTo({ type: "item", id: entryId(at) });
    },
    [viewer, isReady, entries, at],
  );
  const letGo = useCallback(() => {
    cancelAnimationFrame(holding.current);
    goal.current = null;
  }, []);
  /** Over the frames in which what is above it is drawn and measured. */
  const hold = useCallback(
    (place: AllFilesPlace) => {
      let frames = 0;
      const again = () => {
        const instance = viewer();
        if (!instance?.getItem(place.id)) return;
        scrollToPlace(instance, place, HEADER);
        frames += 1;
        if (frames < HELD_FRAMES)
          holding.current = requestAnimationFrame(again);
      };
      cancelAnimationFrame(holding.current);
      again();
    },
    [viewer],
  );
  useEffect(() => () => cancelAnimationFrame(holding.current), []);
  const latestStart = useRef(startsAt);
  useLayoutEffect(
    function goToStart() {
      const line = isReady ? latestStart.current() : null;
      if (!line) return;
      hold({
        id: entryId(begins, line.part),
        line: { side: line.side, number: line.number },
        below: Math.max(line.below, HEADER),
      });
    },
    [isReady, hold, begins],
  );
  const leave = (place: AllFilesPlace | null) => {
    report();
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
    const events = ["wheel", "pointerdown", "keydown", "touchmove"];
    for (const event of events)
      root.addEventListener(event, letGo, { passive: true });
    if (holdsFocus.current || document.activeElement === pane.current)
      root.focus({ preventScroll: true });
    holdsFocus.current = false;
    return () => {
      for (const event of events) root.removeEventListener(event, letGo);
      holdsFocus.current = root.contains(document.activeElement);
    };
  }, [isReady, pane, holdsFocus, letGo]);

  const step = (by: 1 | -1): boolean => {
    const instance = viewer();
    const root = scroller.current;
    if (!instance || !root) return false;
    const all = [...entries.values()];
    const most = Math.max(
      0,
      instance.getScrollHeight() + layout.paddingBottom - instance.getHeight(),
    );
    const top = instance.getScrollTop();
    const rendered = instance.getRenderedItems();
    cancelAnimationFrame(holding.current);
    const from = goal.current?.id ?? pinned(instance);
    const first = all.findIndex(({ id }) => id === from);
    const go = (
      entry: FileEntry,
      stop: { side: "deletions" | "additions"; line: number },
    ) => {
      goal.current = { id: entry.id };
      if (shownAt.current !== entry.at) {
        shownAt.current = entry.at;
        onAt(entry.at);
      }
      instance.scrollTo({
        type: "line",
        id: entry.id,
        lineNumber: stop.line,
        side: stop.side,
        offset: ABOVE_CHANGE,
      });
      // The next step may come before the next frame.
      instance.render(true);
      return true;
    };
    for (let index = first; index >= 0 && index < all.length; index += by) {
      const entry = all[index];
      if (!entry?.diff || folded.has(entry.file)) continue;
      const stops = changeStops([entry.diff]);
      const item = rendered.find(({ id }) => id === entry.id);
      if (index === first && item?.type === "diff") {
        const start = instance.getTopForItem(entry.id) ?? 0;
        const next = nextChange(
          stops.length,
          (change) => {
            const stop = stops[change];
            return (
              start +
              ((stop &&
                item.instance.getLinePosition(stop.line, stop.side)?.top) ??
                0)
            );
          },
          { at: top, most, above: HEADER + ABOVE_CHANGE },
          by,
        );
        const stop = next && stops[next.change];
        if (stop) return go(entry, stop);
        continue;
      }
      const stop = by === 1 ? stops[0] : stops.at(-1);
      if (stop) return go(entry, stop);
    }
    return true;
  };
  useImperativeHandle(ref, () => ({ step }));

  if (!isReady) return <ReadingFiles />;
  return (
    <TurnsContext value={turns}>
      <KeepAllFilesPlace
        viewer={viewer}
        header={HEADER}
        isShown={isShown}
        onAppear={(place) => {
          setAppearances((before) => before + 1);
          if (place) hold(place);
        }}
        onLeave={leave}
      />
      <div className="file-diff-body files-body">
        <Viewer<FileNote>
          ref={handle}
          containerRef={scroller}
          className="file-diff-scroll files-all-scroll"
          items={items}
          options={options}
          onScroll={onScroll}
          renderCustomHeader={({ id }) => {
            const entry = entries.get(id);
            return (
              entry && (
                <FileHeader
                  entry={entry}
                  folded={folded.has(entry.file)}
                  onFold={() => {
                    const instance = viewer();
                    const top = instance?.getTopForItem(id) ?? 0;
                    // Pierre keeps the place in it, where nothing will be.
                    if (instance && top < instance.getScrollTop())
                      instance.scrollTo({ type: "item", id });
                    onFold(entry.file);
                  }}
                />
              )
            );
          }}
          renderAnnotation={(...[{ metadata }, , { id }]) => {
            const entry = entries.get(id);
            if (!entry) return null;
            return metadata === "file" ? (
              <OverLines
                entry={entry}
                contentMissing={contentMissing}
                viewer={login}
                url={url}
                unfolded={unfolded}
                onRead={onRead}
                onReadAgain={onReadAgain}
              />
            ) : (
              <ThreadChips
                ids={metadata}
                threads={threads.get(entry.file) ?? []}
                viewer={login}
                url={url}
                unfolded={unfolded}
              />
            );
          }}
        />
      </div>
    </TurnsContext>
  );
}
