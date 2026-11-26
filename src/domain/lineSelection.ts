import { HUNK_HEADER, parsePatchFiles } from "@pierre/diffs";
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  Hunk,
  SelectedLineRange,
} from "@pierre/diffs";
import type { LinePick, LineSide, WorktreePatch } from "./repository";

export type DiffStyle = "unified" | "split";

/** One row as Pierre draws it, in a hunk. */
export type Row = {
  hunk: number;
  deletion?: number;
  addition?: number;
  context?: { old: number; new: number };
};

export function shownText(patch: WorktreePatch): string | null {
  return patch.kind === "diff" && patch.diff.kind === "text"
    ? patch.diff.patch
    : null;
}

let lastParse: { patch: string; files: FileDiffMetadata[] } | null = null;

export function parsedFiles(patch: string): FileDiffMetadata[] {
  if (lastParse?.patch !== patch)
    lastParse = {
      patch,
      files: parsePatchFiles(patch).flatMap((parsed) => parsed.files),
    };
  return lastParse.files;
}

const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";

const isLinkOrSubmodule = (mode: string | undefined) =>
  mode === SYMLINK_MODE || mode === SUBMODULE_MODE;

const headerOf = (patch: string) => patch.slice(0, patch.indexOf("\n@@"));

const isCopy = (patch: string) => /^copy from /m.test(headerOf(patch));

function linesMatchHeader(hunk: Hunk): boolean {
  const [, , deletions = "1", , additions = "1"] =
    HUNK_HEADER.exec(hunk.hunkSpecs ?? "") ?? [];
  const context = hunk.hunkContent.reduce(
    (sum, block) => sum + (block.type === "context" ? block.lines : 0),
    0,
  );
  return (
    Number(deletions) === context + hunk.deletionLines &&
    Number(additions) === context + hunk.additionLines
  );
}

export function splittable(patch: string): boolean {
  const [file, ...typeChangeHalf] = parsedFiles(patch);
  return (
    file !== undefined &&
    typeChangeHalf.length === 0 &&
    file.hunks.length > 0 &&
    file.hunks.every(linesMatchHeader) &&
    !isCopy(patch) &&
    !isLinkOrSubmodule(file.mode) &&
    !isLinkOrSubmodule(file.prevMode)
  );
}

function rowsAsPierreDraws(file: FileDiffMetadata, style: DiffStyle): Row[] {
  const rows: Row[] = [];
  file.hunks.forEach((hunk, index) => {
    let old = hunk.deletionStart;
    let next = hunk.additionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let line = 0; line < block.lines; line++)
          rows.push({ hunk: index, context: { old: old++, new: next++ } });
        continue;
      }
      const deletions = Array.from({ length: block.deletions }, () => old++);
      const additions = Array.from({ length: block.additions }, () => next++);
      if (style === "unified") {
        for (const deletion of deletions) rows.push({ hunk: index, deletion });
        for (const addition of additions) rows.push({ hunk: index, addition });
      } else
        for (let k = 0; k < Math.max(deletions.length, additions.length); k++)
          rows.push({
            hunk: index,
            deletion: deletions[k],
            addition: additions[k],
          });
    }
  });
  return rows;
}

/**
 * The rows from the first at or after `line` to the last at or before it. An
 * expanded line between hunks has no row, so the two ends cross.
 */
function reach(rows: Row[], side: LineSide, line: number) {
  const lineOf = (row: Row) =>
    side === "deletions"
      ? (row.deletion ?? row.context?.old)
      : (row.addition ?? row.context?.new);
  const first = rows.findIndex((row) => (lineOf(row) ?? -Infinity) >= line);
  return {
    first: first < 0 ? rows.length : first,
    last: rows.findLastIndex((row) => (lineOf(row) ?? Infinity) <= line),
  };
}

/** The rows a range covers, top first, and the side each end of it is on. */
export function rowsOf(
  file: FileDiffMetadata,
  style: DiffStyle,
  range: SelectedLineRange,
): { rows: Row[]; top: LineSide; bottom: LineSide } {
  const rows = rowsAsPierreDraws(file, style);
  const startSide = range.side ?? "additions";
  const endSide = range.endSide ?? startSide;
  const start = reach(rows, startSide, range.start);
  const end = reach(rows, endSide, range.end);
  const startsOnTop = start.first + start.last <= end.first + end.last;
  const [top, bottom] = startsOnTop ? [start, end] : [end, start];
  return {
    rows: rows.slice(top.first, bottom.last + 1),
    top: startsOnTop ? startSide : endSide,
    bottom: startsOnTop ? endSide : startSide,
  };
}

export function picksFor(
  file: FileDiffMetadata,
  style: DiffStyle,
  range: SelectedLineRange,
): LinePick[] {
  return rowsOf(file, style, range).rows.flatMap((row) => [
    ...(row.deletion === undefined
      ? []
      : [{ side: "deletions" as const, line: row.deletion }]),
    ...(row.addition === undefined
      ? []
      : [{ side: "additions" as const, line: row.addition }]),
  ]);
}

export type HunkBar = { hunk: number };

/**
 * Pierre draws an annotation below its line, so the bar anchors on the last
 * leading context line, between the context and the first change.
 */
export function hunkAnchor(
  hunk: Hunk,
  index: number,
): DiffLineAnnotation<HunkBar> | null {
  const [lead] = hunk.hunkContent;
  if (lead?.type !== "context") return null;
  return {
    side: "additions",
    lineNumber: hunk.additionStart + lead.lines - 1,
    metadata: { hunk: index },
  };
}

export type DiscardEffect = "deleteFile" | "removeLines" | "restoreLines";

export function discardEffect(
  file: FileDiffMetadata,
  picks: readonly LinePick[] | "hunk",
): DiscardEffect {
  if (file.type !== "new") return "restoreLines";
  const [only, ...rest] = file.hunks;
  const takesEveryLine =
    only !== undefined &&
    rest.length === 0 &&
    (picks === "hunk" || picks.length === only.additionLines);
  return takesEveryLine ? "deleteFile" : "removeLines";
}
