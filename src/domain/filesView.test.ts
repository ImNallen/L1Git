import { describe, expect, it } from "vitest";
import { afterMove, currentFile, viewAt, viewToMark } from "./filesView";
import type { FilesPlace, FilesView } from "./filesView";

const line = (number: number, below: number, id = "3.0"): FilesPlace => ({
  id,
  line: { side: "additions", number },
  below,
});
const top = (id: string, below = 0): FilesPlace => ({ id, line: null, below });
const free: FilesView = { kind: "free" };
const put = (place: FilesPlace, file: number | null = null): FilesView => ({
  kind: "put",
  place,
  file,
});

describe("currentFile", () => {
  it.each([
    ["the one at the top while the reader scrolls", free, 4],
    ["the one that was gone to", put(top("7.0"), 7), 7],
    ["the one at the top of a place that is kept", put(line(1, 60)), 4],
  ])("is %s", (_, view, expected) => {
    expect(currentFile(view, 4)).toBe(expected);
  });

  it("is none before anything is drawn", () => {
    expect(currentFile(free, null)).toBeNull();
  });
});

describe("viewAt", () => {
  it("keeps the place of a reader, whose current file is the one at the top", () => {
    expect(viewAt(free, line(8, 50))).toEqual(put(line(8, 50)));
  });

  it("keeps the current file", () => {
    expect(viewAt(put(top("7.0"), 7), line(8, 50))).toEqual(
      put(line(8, 50), 7),
    );
  });

  it("changes nothing without a place", () => {
    expect(viewAt(free, null)).toBe(free);
  });
});

describe("afterMove", () => {
  it.each([
    [500, 500, null, "stay"],
    [500, 500.6, 500, "stay"],
    // Nothing is known of before.
    [500, 900, null, "put"],
    // The layout changed.
    [500, 900, 500, "put"],
    [900, 500, 480, "put"],
    // The layout is the same.
    [530, 500, 500, "free"],
    [0, 500, 500.4, "free"],
  ] as const)(
    "at %d, for %d after %s, says %s",
    (scrollTop, wanted, last, expected) => {
      expect(afterMove(scrollTop, wanted, last)).toBe(expected);
    },
  );
});

describe("viewToMark", () => {
  const here = line(40, 60);
  const mark = {
    at: 3,
    isViewed: true,
    isFolded: false,
    here,
    own: top("3.0"),
    below: -500,
    next: top("4.0"),
  };
  const marked: FilesView = {
    kind: "marked",
    place: top("4.0"),
    file: 3,
    of: 3,
    back: here,
  };
  it.each<[string, FilesView, Partial<typeof mark>, FilesView | null]>([
    ["brings the next file to a pinned header", free, {}, marked],
    [
      "keeps a pinned header with the focus, and the last",
      free,
      { next: null as never },
      { ...marked, place: top("3.0") },
    ],
    [
      "leaves a header in the view where it is",
      free,
      { below: 0 },
      { ...marked, place: here, file: null },
    ],
    [
      "leaves another file current",
      put(top("2.0"), 2),
      { below: 80, here: top("2.0") },
      { ...marked, place: top("2.0"), file: 2, back: top("2.0") },
    ],
    [
      "leaves the one a step went to current under another's header",
      put(line(1, 106, "4.0"), 4),
      {},
      { ...marked, file: 4 },
    ],
    ["moves nothing for a file that is folded", free, { isFolded: true }, null],
    [
      "moves nothing for a viewed file that a hand unfolded",
      free,
      { isViewed: false },
      null,
    ],
    [
      "goes back to where it was marked",
      marked,
      { isViewed: false, isFolded: true },
      put(here, 3),
    ],
    [
      "begins at the top of a file that was marked before",
      { ...marked, of: 2 },
      { isViewed: false, isFolded: true, below: -40 },
      put(top("3.0"), 3),
    ],
    [
      "unfolds a header in the view where it is",
      free,
      { isViewed: false, isFolded: true, below: 0 },
      null,
    ],
  ])("%s", (_, view, fields, expected) => {
    expect(viewToMark(view, { ...mark, ...fields })).toEqual(expected);
  });
});
