import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { draftKey, placed } from "./drafts";
import type { DraftKey } from "./drafts";
import type { PullWrite } from "./pullRequestWrites";
import type { Anchor } from "./drafts";
import { rowsOf } from "./lineSelection";
import type { DiffStyle, Row } from "./lineSelection";
import type { LineSide } from "./repository";

/** Where a line comment goes, in GitHub's terms. */
export type LineAnchor = Extract<Anchor, { kind: "line" }>;
/** A line comment's place, as a write names it. */
export type Lines = Omit<LineAnchor, "kind">;
type Side = LineAnchor["side"];

const sides = { left: "deletions", right: "additions" } as const;

function lineOf(row: Row, chosen: LineSide): { side: Side; line: number } {
  if (row.context)
    return chosen === "deletions"
      ? { side: "left", line: row.context.old }
      : { side: "right", line: row.context.new };
  if (
    row.deletion !== undefined &&
    (row.addition === undefined || chosen === "deletions")
  )
    return { side: "left", line: row.deletion };
  return { side: "right", line: row.addition ?? 0 };
}

/**
 * What GitHub takes for the lines Pierre has chosen: only lines inside a
 * hunk, and all of them in one hunk, the one the range ends in. Null when the
 * range holds no line of a hunk, as expanded lines between hunks.
 */
export function placeOf(
  file: FileDiffMetadata,
  style: DiffStyle,
  path: string,
  range: SelectedLineRange,
): LineAnchor | null {
  const { rows, top, bottom } = rowsOf(file, style, range);
  const last = rows.at(-1);
  if (!last) return null;
  const first = rows.find(({ hunk }) => hunk === last.hunk) ?? last;
  const end = lineOf(last, bottom);
  const start = lineOf(first, top);
  const anchor = placed({
    kind: "line",
    path,
    ...end,
    start: first === last && start.side === end.side ? null : start,
  });
  return anchor.kind === "line" ? anchor : null;
}

/** The lines Pierre highlights for a comment's place. */
export function rangeOf({ side, line, start }: Lines): SelectedLineRange {
  return {
    start: start?.line ?? line,
    side: sides[start?.side ?? side],
    end: line,
    endSide: sides[side],
  };
}

/** The run of changed lines that begins at `begin`, as `changeStops` names
 * each one, or null when none begins there. */
export function runAt(
  { hunks }: FileDiffMetadata,
  begin: { side: LineSide; line: number },
): SelectedLineRange | null {
  for (const { deletionStart, additionStart, hunkContent } of hunks) {
    let deletion = deletionStart;
    let addition = additionStart;
    let starts: { side: LineSide; line: number } | null = null;
    for (const block of hunkContent) {
      if (block.type === "context") {
        starts = null;
        deletion += block.lines;
        addition += block.lines;
        continue;
      }
      starts ??=
        block.deletions > 0
          ? { side: "deletions", line: deletion }
          : { side: "additions", line: addition };
      deletion += block.deletions;
      addition += block.additions;
      if (starts.side !== begin.side || starts.line !== begin.line) continue;
      const next = hunkContent[hunkContent.indexOf(block) + 1];
      if (next?.type === "change") continue;
      return {
        start: starts.line,
        side: starts.side,
        end: block.additions > 0 ? addition - 1 : deletion - 1,
        endSide: block.additions > 0 ? "additions" : "deletions",
      };
    }
  }
  return null;
}

/** "line 11", or "lines 10–12". */
export function linesLabel({ line, start }: Pick<Lines, "line" | "start">) {
  return start === null ? `line ${line}` : `lines ${start.line}–${line}`;
}

/** The line drafts a write carries, which its own card shows while it is on
 * its way: the host has them, and this window learns so when it answers. */
export function carriedBy(write: PullWrite): DraftKey[] {
  switch (write.kind) {
    case "singleComment":
      return [draftKey({ kind: "line", ...write.lines }, write.commit)];
    case "submitReview":
      return write.threads.map(({ lines }) =>
        draftKey({ kind: "line", ...lines }, write.commit),
      );
    default:
      return [];
  }
}
