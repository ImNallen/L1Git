import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileContents,
  FileDiffMetadata,
} from "@pierre/diffs";
import { inPlaceOfLines, modeChange, shownPath } from "../domain/filesChanged";
import type { ReviewThread } from "../domain/pullRequest";
import type { RangeFile } from "../domain/range";
import type { FilePatch } from "../domain/repository";
import { placeThreads } from "../domain/reviewThreads";
import type { FilesChanged, PatchRead } from "../filesChanged";

const TURN_MS = 8;

/** The threads on a line, or what there is to say over a file's lines. */
export type FileNote = readonly string[] | "file";
type Note = DiffLineAnnotation<FileNote>;

/** A file, or one of the two parts of a file whose type changed. */
export type FileEntry = {
  id: string;
  at: number;
  part: number;
  parts: number;
  file: RangeFile;
  /** Null for a file without lines to draw. */
  diff: FileDiffMetadata | null;
  /** What it says in place of lines. */
  words: string | null;
  /** Undefined until it was asked for. */
  read: PatchRead | undefined;
  elsewhere: readonly ReviewThread[];
  mode: string | null;
  lossy: boolean;
  /** Whether a line may be taller than the others. */
  isUneven: boolean;
};

export const entryId = (at: number, part = 0) => `${at}.${part}`;

/** What the browser breaks a line at and Git doesn't. */
const breaks = /\r(?!\n)|[\u2028\u2029]/;
const brokenPatches = new WeakSet<FilePatch>();

const parsed = new WeakMap<FilePatch, FileDiffMetadata[]>();
const filesOfDiffs = new WeakMap<FileDiffMetadata, RangeFile>();
export const fileOfDiff = (diff: FileDiffMetadata) => filesOfDiffs.get(diff);

/** The same objects each time, which Pierre fills with the lines of an expanded hunk. */
function partsOf(file: RangeFile, patch: FilePatch): FileDiffMetadata[] {
  if (patch.kind !== "text" || inPlaceOfLines(file, patch) !== null) return [];
  const before = parsed.get(patch);
  if (before) return before;
  const parts = parsePatchFiles(patch.patch).flatMap(({ files }) => files);
  for (const part of parts) filesOfDiffs.set(part, file);
  parsed.set(patch, parts);
  if (breaks.test(patch.patch)) brokenPatches.add(patch);
  return parts;
}

/** How many files are parsed. A few are in each frame, so that none takes long. */
function useParsed(
  files: readonly RangeFile[],
  patches: FilesChanged["patches"],
  contentMissing: boolean,
): number {
  const [count, setCount] = useState(0);
  const isRead = patches !== null;
  const newest = useRef(patches);
  newest.current = patches;
  useEffect(() => {
    if (contentMissing || !isRead) return;
    let next = 0;
    let frame = 0;
    const work = () => {
      const end = performance.now() + TURN_MS;
      for (; next < files.length && performance.now() < end; next += 1) {
        const file = files[next];
        const read = file && newest.current?.get(file);
        if (file && read?.kind === "ready") partsOf(file, read.patch);
      }
      setCount(next);
      if (next < files.length) frame = requestAnimationFrame(work);
    };
    work();
    return () => cancelAnimationFrame(frame);
  }, [files, isRead, contentMissing]);
  return contentMissing ? files.length : count;
}

function entriesOf(
  at: number,
  file: RangeFile,
  read: PatchRead | undefined,
  threads: readonly ReviewThread[],
) {
  const patch = read?.kind === "ready" ? read.patch : null;
  const diffs = patch ? partsOf(file, patch) : [];
  const { onLines, elsewhere } = placeThreads(threads, diffs);
  const whole: FileEntry = {
    id: entryId(at),
    at,
    part: 0,
    parts: diffs.length,
    file,
    diff: diffs[0] ?? null,
    words: patch && inPlaceOfLines(file, patch),
    read,
    elsewhere,
    mode: patch && diffs.length > 0 ? modeChange(patch) : null,
    lossy: patch?.kind === "text" && patch.lossy,
    isUneven: patch !== null && brokenPatches.has(patch),
  };
  const rest = diffs.slice(1).map(
    (diff, index): FileEntry => ({
      ...whole,
      id: entryId(at, index + 1),
      part: index + 1,
      diff,
      elsewhere: [],
    }),
  );
  return [whole, ...rest].map((entry) => ({
    entry,
    onLines: onLines[entry.part] ?? [],
  }));
}

const linelessFiles = new WeakMap<RangeFile, FileContents>();

/** The same object each time, or Pierre throws when it draws it folded after unfolded. */
function lineless(file: RangeFile): FileContents {
  const before = linelessFiles.get(file);
  if (before) return before;
  const name = shownPath(file.path);
  // Pierre draws no note on a file without lines, so this has one to hide.
  const made: FileContents = { name, contents: "\n", lang: "text" };
  linelessFiles.set(file, made);
  return made;
}

const hasNote = (entry: FileEntry) =>
  entry.diff === null ||
  // Pierre measures the lines of what has a note.
  entry.isUneven ||
  (entry.part === 0 &&
    (entry.file.from !== null ||
      entry.mode !== null ||
      entry.lossy ||
      entry.elsewhere.length > 0));

function itemOf(
  entry: FileEntry,
  onLines: readonly Note[],
  collapsed: boolean,
  version: number,
): CodeViewItem<FileNote> {
  const { id, diff, file } = entry;
  if (diff === null)
    return {
      id,
      type: "file",
      file: lineless(file),
      annotations: [{ lineNumber: 0, metadata: "file" }],
      collapsed,
      version,
    };
  const top: Note = {
    side: diff.type === "deleted" ? "deletions" : "additions",
    lineNumber: 0,
    metadata: "file",
  };
  return {
    id,
    type: "diff",
    fileDiff: diff,
    annotations: hasNote(entry) ? [top, ...onLines] : [...onLines],
    collapsed,
    version,
  };
}

type Made = { item: CodeViewItem<FileNote>; like: string };

/** What `CodeView` shows. An item stays the same until Pierre has to draw it again. */
export function useFileItems(
  files: readonly RangeFile[],
  patches: FilesChanged["patches"],
  contentMissing: boolean,
  threads: ReadonlyMap<RangeFile, readonly ReviewThread[]>,
  folded: ReadonlySet<RangeFile>,
) {
  const count = useParsed(files, patches, contentMissing);
  const before = useRef<ReadonlyMap<string, Made>>(new Map());
  return useMemo(() => {
    const entries = new Map<string, FileEntry>();
    const made = new Map<string, Made>();
    for (const [at, file] of files.slice(0, count).entries())
      for (const { entry, onLines } of entriesOf(
        at,
        file,
        patches?.get(file),
        threads.get(file) ?? [],
      )) {
        const collapsed = folded.has(file);
        const like = JSON.stringify([collapsed, hasNote(entry), onLines]);
        const last = before.current.get(entry.id);
        const isSame =
          last?.like === like &&
          (last.item.type === "diff"
            ? last.item.fileDiff === entry.diff
            : entry.diff === null);
        const version = (last?.item.version ?? 0) + 1;
        entries.set(entry.id, entry);
        made.set(
          entry.id,
          last && isSame
            ? last
            : { like, item: itemOf(entry, onLines, collapsed, version) },
        );
      }
    before.current = made;
    const items = [...made.values()].map(({ item }) => item);
    return { items, entries, count };
  }, [files, count, patches, threads, folded]);
}
