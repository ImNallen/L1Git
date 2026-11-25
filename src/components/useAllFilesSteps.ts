import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { CodeView, FileDiffMetadata } from "@pierre/diffs";
import { changeStops } from "../domain/changeStops";
import type { ChangeStop } from "../domain/changeStops";
import { furtherStep, stepFrom, stepInView } from "../domain/fileSteps";
import type { FileStep } from "../domain/fileSteps";
import type { RangeFile } from "../domain/range";
import { ABOVE_CHANGE } from "./useDiffSteps";
import { entryId } from "./useFileItems";
import type { FileEntry, FileNote } from "./useFileItems";

type Viewer = CodeView<FileNote>;

/** As the stylesheet has it. */
export const HEADER = 40;
export const layout = { paddingTop: 0, paddingBottom: 64, gap: 0 };
const REPORT_MS = 100;
/** Long enough for Pierre to draw and measure where it went. */
const SETTLES_MS = 250;

/** What a step went to. Its file is current until the reader scrolls. */
type Goal = {
  id: string;
  /** -1 for the beginning of the file. */
  change: number;
  /** Goes on from a file that is not read once it is. */
  waits: 1 | -1 | null;
  settled: number;
};

const stopsOfDiffs = new WeakMap<FileDiffMetadata, ChangeStop[]>();
function stopsOf({ diff }: FileEntry): ChangeStop[] {
  if (!diff) return [];
  const stops = stopsOfDiffs.get(diff) ?? changeStops([diff]);
  stopsOfDiffs.set(diff, stops);
  return stops;
}

const isUnread = ({ diff, words, read }: FileEntry) =>
  diff === null && words === null && read?.kind !== "failed";

/** How far it scrolls. */
const reach = (viewer: Viewer) =>
  Math.max(
    0,
    viewer.getScrollHeight() + layout.paddingBottom - viewer.getHeight(),
  );

/** The one whose header is pinned. */
const pinned = (viewer: Viewer) =>
  viewer
    .getRenderedItems()
    .findLast(
      ({ id }) =>
        (viewer.getTopForItem(id) ?? Infinity) <= viewer.getScrollTop() + 1,
    )?.id;

/** Where the view would begin for a change, if the view were endless. */
function topOf(viewer: Viewer, entry: FileEntry, change: number) {
  const start = viewer.getTopForItem(entry.id);
  if (start === undefined || change < 0) return start;
  const stop = stopsOf(entry)[change];
  const item = viewer.getRenderedItems().find(({ id }) => id === entry.id);
  if (!stop || item?.type !== "diff") return undefined;
  const line = item.instance.getLinePosition(stop.line, stop.side);
  return line && start + line.top - HEADER - ABOVE_CHANGE;
}

/** Which change of its file a step is to go on from, or null to go on from the view. */
function leftAt(
  { change, waits }: Goal,
  count: number,
  isBelow: boolean,
  by: 1 | -1,
): number | null {
  if (change >= 0) return change;
  if (waits === null && !isBelow) return null;
  if (by === 1) return -1;
  return waits === -1 ? count : 0;
}

/** Steps through the files and their changes, and which file is current. */
export function useAllFilesSteps({
  viewer,
  entries,
  folded,
  contentMissing,
  at,
  isReady,
  onAt,
  onRead,
}: {
  viewer: () => Viewer | undefined;
  entries: ReadonlyMap<string, FileEntry>;
  folded: ReadonlySet<RangeFile>;
  contentMissing: boolean;
  at: number;
  isReady: boolean;
  onAt: (at: number) => void;
  onRead: (file: RangeFile) => void;
}) {
  const shownAt = useRef(0);
  const goal = useRef<Goal | null>(null);
  const timer = useRef(0);

  const aimAt = useCallback(
    (id: string, change = -1, waits: Goal["waits"] = null) => {
      const settled = performance.now() + SETTLES_MS;
      goal.current = { id, change, waits, settled };
    },
    [],
  );
  const goTo = useCallback(
    (id: string) => {
      aimAt(id);
      const instance = viewer();
      instance?.scrollTo({ type: "item", id });
      // A key before the next frame would make Pierre forget it.
      queueMicrotask(() => instance?.render(true));
    },
    [viewer, aimAt],
  );
  /** Whether the goal is where the step left it. */
  const isAt = useCallback(
    (instance: Viewer, { id, change, settled }: Goal, within: number) => {
      if (performance.now() < settled) return true;
      const entry = entries.get(id);
      const top = entry && topOf(instance, entry, change);
      if (top === undefined) return false;
      const wanted = Math.min(Math.max(top, 0), reach(instance));
      return Math.abs(instance.getScrollTop() - wanted) <= within;
    },
    [entries],
  );

  const report = useCallback(() => {
    const instance = viewer();
    timer.current = 0;
    if (!instance || instance.getHeight() === 0) return;
    if (goal.current && isAt(instance, goal.current, 2)) return;
    if (goal.current) goal.current.waits = null;
    const current = pinned(instance);
    const now = current === undefined ? undefined : entries.get(current)?.at;
    if (now === undefined || now === shownAt.current) return;
    shownAt.current = now;
    onAt(now);
  }, [viewer, entries, isAt, onAt]);
  const latestReport = useRef(report);
  latestReport.current = report;
  const onScroll = useCallback(() => {
    if (timer.current !== 0) return;
    const look = () => {
      const settles = (goal.current?.settled ?? 0) - performance.now();
      if (settles > 0) timer.current = window.setTimeout(look, settles + 1);
      else latestReport.current();
    };
    timer.current = window.setTimeout(look, REPORT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(function beginAtTop() {
    shownAt.current = 0;
    goal.current = null;
  }, []);
  useLayoutEffect(
    function goToCurrent() {
      if (!isReady || at === shownAt.current) return;
      if (!entries.has(entryId(at))) return;
      shownAt.current = at;
      goTo(entryId(at));
    },
    [isReady, entries, at, goTo],
  );

  const next = (instance: Viewer, by: 1 | -1): FileStep | null => {
    const all = [...entries.values()];
    const countOf = (file: number) => {
      const entry = all[file];
      if (!entry) return undefined;
      if (folded.has(entry.file)) return 0;
      const isComing = !contentMissing && isUnread(entry);
      return isComing ? null : stopsOf(entry).length;
    };
    const { current: from } = goal;
    const file = all.findIndex(({ id }) => id === from?.id);
    let after: FileStep | null = null;
    if (from && file >= 0) {
      const isBelow = (topOf(instance, all[file]!, -1) ?? 0) > reach(instance);
      const change = leftAt(from, countOf(file) ?? 0, isBelow, by);
      if (change !== null) after = stepFrom(countOf, { file, change }, by);
      if (from.waits !== null) return after;
      const isHere = change !== null && isAt(instance, from, ABOVE_CHANGE);
      if (!isHere) after = null;
      else if (after === null) return null;
    }
    const places = new Map(all.map(({ id }, place) => [id, place]));
    const drawn = instance
      .getRenderedItems()
      .flatMap(({ id }) => places.get(id) ?? []);
    const [first] = drawn;
    const last = drawn.at(-1);
    if (first === undefined || last === undefined) return after;
    const inView = stepInView(
      countOf,
      {
        first,
        last,
        file: places.get(pinned(instance) ?? "") ?? first,
        at: instance.getScrollTop(),
      },
      (step) => topOf(instance, all[step.file]!, step.change ?? -1) ?? 0,
      by,
    );
    // After a small scroll back, the one that was gone to is not the next.
    return furtherStep(after, inView, by);
  };
  const step = (by: 1 | -1): true => {
    const instance = viewer();
    const to = instance && next(instance, by);
    const entry = to && [...entries.values()][to.file];
    if (!instance || !entry) return true;
    if (shownAt.current !== entry.at) {
      shownAt.current = entry.at;
      onAt(entry.at);
    }
    const stop = to.change === null ? undefined : stopsOf(entry)[to.change];
    if (stop) {
      aimAt(entry.id, to.change ?? -1);
      instance.scrollTo({
        type: "line",
        id: entry.id,
        lineNumber: stop.line,
        side: stop.side,
        offset: ABOVE_CHANGE,
      });
    } else {
      const { current: before } = goal;
      const isThere = before?.id === entry.id && before.waits !== null;
      if (!isThere) instance.scrollTo({ type: "item", id: entry.id });
      aimAt(entry.id, -1, by);
      onRead(entry.file);
    }
    // The next step may come before the next frame.
    instance.render(true);
    return true;
  };
  const latestStep = useRef(step);
  latestStep.current = step;
  useLayoutEffect(
    function goOn() {
      const { current: from } = goal;
      const entry = from && entries.get(from.id);
      if (!entry || from.waits === null || isUnread(entry)) return;
      const { waits } = from;
      if (entry.read?.kind === "failed") from.waits = null;
      else queueMicrotask(() => latestStep.current(waits));
    },
    [entries],
  );
  /** The reader goes elsewhere. */
  const letGo = useCallback(() => {
    if (!goal.current) return;
    goal.current.waits = null;
    goal.current.settled = 0;
  }, []);

  return { step, goTo, report, onScroll, letGo };
}
