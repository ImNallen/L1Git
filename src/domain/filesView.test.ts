import { describe, expect, it } from "vitest";
import { afterMove, currentFile, viewAt } from "./filesView";
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
