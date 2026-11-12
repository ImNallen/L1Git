type Marker = "start" | "base" | "separator" | "end";

const markers: Record<string, Marker> = {
  "<": "start",
  "|": "base",
  ">": "end",
};

/** Reads a line as `@pierre/diffs` does when it draws the resolver. */
function marker(line: string): Marker | null {
  const content = line.replace(/\r$/, "");
  const first = content[0];
  if (first === undefined) return null;
  let run = 0;
  while (content[run] === first) run++;
  if (run < 7) return null;
  if (first === "=") return run === content.length ? "separator" : null;
  if (run !== content.length && !/[\t\n\v\f\r ]/.test(content[run] ?? ""))
    return null;
  return markers[first] ?? null;
}

export function conflictRegions(text: string): number {
  let open = 0;
  let closed = 0;
  for (const line of text.split("\n")) {
    const kind = marker(line);
    if (kind === "start") open++;
    else if (kind === "end" && open > 0) {
      open--;
      closed++;
    }
  }
  return closed;
}

const leftover = /^([<=>|])\1{6}(?:[\t\v\f\r ]|$)/;

/**
 * Applies `git diff --check`'s leftover-marker rule at Git's default marker
 * size: exactly seven of one marker character, then whitespace or the end of
 * the line. Git skips a final line with no newline; this flags it too.
 */
export const hasLeftoverMarkers = (text: string) =>
  text.split("\n").some((line) => leftover.test(line));
