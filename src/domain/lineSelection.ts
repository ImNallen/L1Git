import { parsePatchFiles } from "@pierre/diffs";
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  Hunk,
  SelectedLineRange,
} from "@pierre/diffs";
import type { LinePick, LineSide, WorktreePatch } from "./repository";

export type DiffStyle = "unified" | "split";

type Row = {
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

export function splittable(patch: string): boolean {
  const [file, ...typeChangeHalf] = parsedFiles(patch);
  return (
    file !== undefined &&
    typeChangeHalf.length === 0 &&
    file.hunks.length > 0 &&
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

function rowAt(rows: Row[], side: LineSide, line: number): number {
  return rows.findIndex((row) =>
    side === "deletions"
      ? row.deletion === line || row.context?.old === line
      : row.addition === line || row.context?.new === line,
  );
}

export function picksFor(
  file: FileDiffMetadata,
  style: DiffStyle,
  range: SelectedLineRange,
): LinePick[] {
  const rows = rowsAsPierreDraws(file, style);
  const start = rowAt(rows, range.side ?? "additions", range.start);
  const end = rowAt(
    rows,
    range.endSide ?? range.side ?? "additions",
    range.end,
  );
  if (start < 0 || end < 0) return [];
  const picks: LinePick[] = [];
  for (const row of rows.slice(
    Math.min(start, end),
    Math.max(start, end) + 1,
  )) {
    if (row.deletion !== undefined)
      picks.push({ side: "deletions", line: row.deletion });
    if (row.addition !== undefined)
      picks.push({ side: "additions", line: row.addition });
  }
  return picks;
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

export function deletesNewFile(
  file: FileDiffMetadata,
  picks: readonly LinePick[] | "hunk",
): boolean {
  const [only, ...rest] = file.hunks;
  if (file.type !== "new" || only === undefined || rest.length > 0)
    return false;
  return picks === "hunk" || picks.length === only.additionLines;
}
