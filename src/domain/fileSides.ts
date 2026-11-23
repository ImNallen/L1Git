import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import type { FilePatch } from "./repository";

export function patchText(diff: FilePatch | null): string {
  if (diff?.kind !== "text") throw new Error("The file has no text diff.");
  return diff.patch;
}

/**
 * Rebuilds both sides of `shown` from the same read with every line of
 * context. The file can change between the two reads, so a side that
 * disagrees with a shown hunk throws instead of hydrating the diff.
 */
export function sidesFor(
  shown: FileDiffMetadata,
  wholePatch: string,
): FileDiffLoadedFiles {
  const whole = parsePatchFiles(wholePatch)
    .flatMap((parsed) => parsed.files)
    .find((file) => file.name === shown.name && file.type === shown.type);
  if (whole === undefined)
    throw new Error(`The whole-file diff has no ${shown.name}.`);
  const agrees = shown.hunks.every(
    (hunk) =>
      sameLines(
        shown.deletionLines.slice(
          hunk.deletionLineIndex,
          hunk.deletionLineIndex + hunk.deletionCount,
        ),
        whole.deletionLines,
        hunk.deletionStart,
      ) &&
      sameLines(
        shown.additionLines.slice(
          hunk.additionLineIndex,
          hunk.additionLineIndex + hunk.additionCount,
        ),
        whole.additionLines,
        hunk.additionStart,
      ),
  );
  if (!agrees)
    throw new Error(`${shown.name} changed after its diff was read.`);
  return {
    oldFile: {
      name: shown.prevName ?? shown.name,
      contents: whole.deletionLines.join(""),
    },
    newFile: { name: shown.name, contents: whole.additionLines.join("") },
  };
}

function sameLines(hunk: string[], side: string[], start: number): boolean {
  const from = Math.max(start - 1, 0);
  return hunk.every((line, index) => side[from + index] === line);
}
