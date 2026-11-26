import { flushSync } from "react-dom";
import type { CodeView, FileDiffMetadata } from "@pierre/diffs";
import { changeStops } from "../domain/changeStops";
import type { ChangeStop } from "../domain/changeStops";
import { furtherStep, stepFrom, stepInView } from "../domain/fileSteps";
import type { FileStep } from "../domain/fileSteps";
import {
  afterMove,
  currentFile,
  viewAt,
  viewToMark,
} from "../domain/filesView";
import type { FilesPlace, FilesView } from "../domain/filesView";
import type { RangeFile } from "../domain/range";
import { ABOVE_CHANGE } from "./useDiffSteps";
import { entryId } from "./useFileItems";
import type { FileEntry, FileNote } from "./useFileItems";

type Viewer = CodeView<FileNote>;

/** As the stylesheet has it. */
export const HEADER = 40;
export const layout = { paddingTop: 0, paddingBottom: 64, gap: 0 };
const REPORT_MS = 100;
/** Over how many frames in which nothing moves Pierre may still draw and measure. */
const STILL_FRAMES = 20;

/** What the next step goes on from. */
type Cursor = {
  id: string;
  /** -1 for the beginning of the file. */
  change: number;
  /** Goes on from a file that is not read once it is. */
  waits: 1 | -1 | null;
};

type Files = {
  entries: ReadonlyMap<string, FileEntry>;
  folded: ReadonlySet<RangeFile>;
  contentMissing: boolean;
  onAt: (at: number) => void;
  onRead: (file: RangeFile) => void;
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

const fileTop = (id: string, below = 0): FilesPlace => ({
  id,
  line: null,
  below,
});

/** Which change of its file a step is to go on from, or null to go on from the view. */
function leftAt(
  { change, waits }: Cursor,
  count: number,
  isBelow: boolean,
  by: 1 | -1,
): number | null {
  if (change >= 0) return change;
  if (waits === null && !isBelow) return null;
  if (by === 1) return -1;
  return waits === -1 ? count : 0;
}

/** Has the view of all files where it is. Whatever else is to move it asks here. */
export class AllFilesKeeper {
  private view: FilesView = { kind: "free" };
  /** Where the view was to begin when it was last there. */
  private last: number | null = null;
  private cursor: Cursor | null = null;
  /** The current file, as others know it. */
  private known = 0;
  private frame = 0;
  /** In how many frames nothing moved. */
  private still = 0;
  private timer = 0;

  constructor(
    private readonly viewer: () => Viewer | undefined,
    private files: Files,
  ) {}

  update(files: Files) {
    this.files = files;
  }

  /** Nothing while it is behind another tab, where nothing has a place. */
  private get shown(): Viewer | undefined {
    const viewer = this.viewer();
    return viewer && viewer.getHeight() > 0 ? viewer : undefined;
  }

  /** How far it scrolls. */
  private reach(viewer: Viewer) {
    const height = viewer.getScrollHeight() + layout.paddingBottom;
    return Math.max(0, height - viewer.getHeight());
  }

  /** The one whose header is pinned. */
  private pinned(viewer: Viewer) {
    return viewer
      .getRenderedItems()
      .findLast(
        ({ id }) =>
          (viewer.getTopForItem(id) ?? Infinity) <= viewer.getScrollTop() + 1,
      )?.id;
  }

  /** Where a line is, or a file's beginning. Undefined for a line that is not drawn. */
  private topOf(viewer: Viewer, { id, line }: Omit<FilesPlace, "below">) {
    const start = viewer.getTopForItem(id);
    if (start === undefined || line === null) return start;
    const item = viewer.getRenderedItems().find((each) => each.id === id);
    if (item?.type !== "diff") return undefined;
    const place = item.instance.getLinePosition(line.number, line.side);
    return place && start + place.top;
  }

  private wanted(viewer: Viewer, place: FilesPlace) {
    const top = this.topOf(viewer, place);
    return top === undefined
      ? undefined
      : Math.min(Math.max(top - place.below, 0), this.reach(viewer));
  }

  private wantedNow(viewer: Viewer) {
    const { view } = this;
    return view.kind === "free"
      ? null
      : (this.wanted(viewer, view.place) ?? null);
  }

  /** The last line of the current file, when all of it is over the view. */
  private end(viewer: Viewer): FilesPlace | null {
    const { entries } = this.files;
    const part = [...entries.values()].findLast(({ at }) => at === this.known);
    const hunk = part?.diff?.hunks.at(-1);
    if (!part || !hunk) return null;
    const isLeft = hunk.additionCount === 0;
    const start = isLeft ? hunk.deletionStart : hunk.additionStart;
    const count = isLeft ? hunk.deletionCount : hunk.additionCount;
    const side = isLeft ? "deletions" : "additions";
    const line = { side, number: start + count - 1 } as const;
    const top = this.topOf(viewer, { id: part.id, line });
    const below = top === undefined ? 0 : top - viewer.getScrollTop();
    return below < 0 ? { id: part.id, line, below } : null;
  }

  /** The line of the current file that comes first in the view, if any does. */
  hereInFile(): FilesPlace | null {
    const viewer = this.shown;
    const here = this.here();
    if (!viewer || !here) return null;
    const at = this.files.entries.get(here.id)?.at;
    return at === this.known && here.line ? here : this.end(viewer);
  }

  /** What comes first in the view under the pinned header. */
  here(): FilesPlace | null {
    const viewer = this.shown;
    if (!viewer) return null;
    let last: FilesPlace | null = null;
    for (const { id, type, instance } of viewer.getRenderedItems()) {
      const top = viewer.getTopForItem(id);
      if (top === undefined) continue;
      const below = top - viewer.getScrollTop();
      if (below >= 0) return fileTop(id, below);
      if (below + instance.getVirtualizedHeight() <= HEADER) continue;
      last = fileTop(id, below);
      if (type === "file") return last;
      const anchor = instance.getNumericScrollAnchor(HEADER - below);
      if (!anchor) continue;
      const { side = "additions", lineNumber: number, top: line } = anchor;
      return { id, line: { side, number }, below: below + line };
    }
    return last;
  }

  /** Until the reader scrolls. */
  put(place: FilesPlace, file: number | null) {
    this.cursor = null;
    this.set({ kind: "put", place, file });
  }

  private set(view: FilesView) {
    this.view = view;
    this.last = null;
    this.watch();
  }

  /** The reader scrolls. */
  readonly free = () => {
    if (this.view.kind === "free") return;
    this.view = { kind: "free" };
    if (this.cursor) this.cursor.waits = null;
    cancelAnimationFrame(this.frame);
    this.tellSoon();
  };

  /** Before the layout changes where the reader scrolled to. */
  readonly remember = () => {
    if (this.view.kind === "free") this.keepHere();
  };

  /** Before the reader changes something that is in the view. */
  readonly touch = () => {
    // A view that is not there yet has no place to keep.
    if (this.view.kind !== "free" && this.last !== null) this.keepHere();
  };

  /** Before the reader unfolds something after a line, or over a file's lines. */
  touchAfter({ id, line }: Omit<FilesPlace, "below">) {
    const viewer = this.shown;
    const top = viewer && this.topOf(viewer, { id, line });
    if (!viewer || top === undefined) return;
    const place = { id, line, below: top - viewer.getScrollTop() };
    this.view = viewAt(this.view, place);
    this.last = this.wantedNow(viewer);
    this.watch();
  }

  private keepHere() {
    const viewer = this.shown;
    if (!viewer) return;
    this.view = viewAt(this.view, this.here());
    this.last = this.wantedNow(viewer);
  }

  /** After the files changed, which moves the view without the reader. */
  readonly changed = () => {
    this.last = null;
    this.watch();
    queueMicrotask(() => this.goOn());
  };

  private check() {
    const viewer = this.shown;
    if (!viewer || this.view.kind === "free") return;
    const { place } = this.view;
    if (!viewer.getItem(place.id)) return this.free();
    const wanted = this.wanted(viewer, place);
    const move =
      wanted === undefined
        ? "put"
        : afterMove(viewer.getScrollTop(), wanted, this.last);
    if (move === "free") return this.free();
    if (move === "put") {
      this.still = 0;
      // What React has to show would come amid Pierre's drawing.
      flushSync(() => {});
      this.scrollTo(viewer);
    }
    this.last = this.wantedNow(viewer);
  }

  private scrollTo(viewer: Viewer) {
    if (this.view.kind === "free") return;
    const { id, line, below } = this.view.place;
    viewer.scrollTo(
      line
        ? {
            type: "line",
            id,
            lineNumber: line.number,
            side: line.side,
            offset: below - HEADER,
          }
        : { type: "item", id, offset: below },
    );
    // A key before the next frame would make Pierre forget it.
    viewer.render(true);
  }

  /** Pierre draws and measures in the frames after a change. */
  private watch() {
    this.still = 0;
    const again = () => {
      cancelAnimationFrame(this.frame);
      this.check();
      this.tellSoon();
      this.still += 1;
      this.frame =
        this.view.kind !== "free" && this.still < STILL_FRAMES
          ? requestAnimationFrame(again)
          : 0;
    };
    // Not amid what React or Pierre is at.
    queueMicrotask(again);
  }

  readonly onScroll = () => {
    this.check();
    this.tellSoon();
  };

  private tellSoon() {
    if (this.timer !== 0) return;
    this.timer = window.setTimeout(this.tell, REPORT_MS);
  }

  /** Says which file is current. */
  readonly tell = () => {
    window.clearTimeout(this.timer);
    this.timer = 0;
    const viewer = this.shown;
    if (!viewer) return;
    const top = this.files.entries.get(this.pinned(viewer) ?? "");
    const at = currentFile(this.view, top?.at ?? null);
    if (at === null || at === this.known) return;
    this.known = at;
    this.files.onAt(at);
  };

  /** Another one became current. */
  goTo(at: number) {
    if (at !== this.known && this.files.entries.has(entryId(at)))
      this.toStart(at);
  }

  toStart(at: number) {
    this.known = at;
    const id = entryId(at);
    this.put(fileTop(id), at);
    this.cursor = { id, change: -1, waits: null };
  }

  /** The header of the file stays where it is. */
  beforeFold(id: string) {
    const viewer = this.shown;
    const top = viewer?.getTopForItem(id);
    const at = this.files.entries.get(id)?.at;
    if (!viewer || top === undefined || at === undefined) return;
    const below = top - viewer.getScrollTop();
    // Nothing will be where the view is in it.
    if (below < 0) this.put(fileTop(id), at);
    else this.touch();
  }

  /** Marking a file folds or unfolds it. `focused` is to stay in the view. */
  beforeMark(at: number, isViewed: boolean, focused: Element | null) {
    const viewer = this.shown;
    const here = this.here();
    const id = entryId(at);
    const top = viewer?.getTopForItem(id);
    const entry = this.files.entries.get(id);
    if (!viewer || !here || !entry || top === undefined) return;
    const next = entryId(at + 1);
    const isFocused = viewer
      .getRenderedItems()
      .some(
        (each) =>
          this.files.entries.get(each.id)?.at === at &&
          each.element.contains(focused),
      );
    const view = viewToMark(this.view, {
      at,
      isViewed,
      isFolded: this.files.folded.has(entry.file),
      here,
      own: fileTop(id),
      below: top - viewer.getScrollTop(),
      next: isFocused || !this.files.entries.has(next) ? null : fileTop(next),
    });
    if (!view) return this.touch();
    this.cursor = null;
    this.set(view);
  }

  /** The file is read again, and is there for as long. */
  beforeRead(at: number) {
    const viewer = this.shown;
    const id = entryId(at);
    const top = viewer?.getTopForItem(id);
    if (!viewer || top === undefined) return;
    this.put(fileTop(id, Math.max(0, top - viewer.getScrollTop())), null);
  }

  private next(viewer: Viewer, by: 1 | -1): FileStep | null {
    const { entries, folded, contentMissing } = this.files;
    const all = [...entries.values()];
    const countOf = (file: number) => {
      const entry = all[file];
      if (!entry) return undefined;
      if (folded.has(entry.file)) return 0;
      const isComing = !contentMissing && isUnread(entry);
      return isComing ? null : stopsOf(entry).length;
    };
    /** Where the view would begin for a step, if it were endless. */
    const topFor = ({ file, change }: FileStep) => {
      const { id } = all[file]!;
      const stop = change === null ? undefined : stopsOf(all[file]!)[change];
      const line = stop ? { side: stop.side, number: stop.line } : null;
      const top = this.topOf(viewer, { id, line });
      return top === undefined
        ? undefined
        : top - (stop ? HEADER + ABOVE_CHANGE : 0);
    };
    const { cursor: from } = this;
    const file = all.findIndex(({ id }) => id === from?.id);
    const reach = this.reach(viewer);
    let after: FileStep | null = null;
    if (from && file >= 0) {
      const isBelow = (topFor({ file, change: null }) ?? 0) > reach;
      const change = leftAt(from, countOf(file) ?? 0, isBelow, by);
      if (change !== null) after = stepFrom(countOf, { file, change }, by);
      if (from.waits !== null) return after;
      const left = topFor({
        file,
        change: from.change < 0 ? null : from.change,
      });
      const isNear =
        left !== undefined &&
        Math.abs(viewer.getScrollTop() - Math.min(Math.max(left, 0), reach)) <=
          ABOVE_CHANGE;
      if (change === null || !isNear) after = null;
      else if (after === null) return null;
    }
    const places = new Map(all.map(({ id }, place) => [id, place]));
    const drawn = viewer
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
        file: places.get(this.pinned(viewer) ?? "") ?? first,
        at: viewer.getScrollTop(),
      },
      (step) => topFor(step) ?? 0,
      by,
    );
    // After a small scroll back, the one that was gone to is not the next.
    return furtherStep(after, inView, by);
  }

  step(by: 1 | -1) {
    const viewer = this.shown;
    // Pierre reckons with what it was last told.
    this.check();
    const to = viewer && this.next(viewer, by);
    const entry = to && [...this.files.entries.values()][to.file];
    if (!entry) return;
    const { id, at, file } = entry;
    const stop = to.change === null ? undefined : stopsOf(entry)[to.change];
    const line = stop ? { side: stop.side, number: stop.line } : null;
    const isWaiting = this.cursor?.id === id && this.cursor.waits !== null;
    if (line || !isWaiting)
      this.put({ id, line, below: line ? HEADER + ABOVE_CHANGE : 0 }, at);
    this.cursor = { id, change: to.change ?? -1, waits: line ? null : by };
    if (!line) this.files.onRead(file);
    // The next step may come before the next frame.
    this.check();
    this.tell();
  }

  private goOn() {
    const { cursor } = this;
    const entry = cursor && this.files.entries.get(cursor.id);
    if (!entry || cursor.waits === null || isUnread(entry)) return;
    const { waits } = cursor;
    if (entry.read?.kind === "failed") cursor.waits = null;
    else this.step(waits);
  }

  stop() {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.timer);
  }
}
