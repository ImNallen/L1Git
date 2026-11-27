// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewThread } from "../domain/pullRequest";
import type { RangeFile } from "../domain/range";
import { oidSchema } from "../domain/repository";
import type { FilesChanged as Held, PatchRead } from "../filesChanged";
import type { FilesChangedState } from "../shell/useFilesChanged";
import { useFilesGoTo } from "./useFilesGoTo";
import type { Left } from "./useFilesGoTo";

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const file: RangeFile = {
  path: "src/a.ts",
  status: "M",
  from: null,
  similarity: null,
  added: 1,
  deleted: 1,
  oldBlob: oid("1"),
  newBlob: oid("2"),
  oldMode: "100644",
  newMode: "100644",
  submodule: false,
};
const thread = { id: "T1", path: "src/a.ts", line: 7, side: "right" };
const drawn: PatchRead = { kind: "ready", patch: {} as never };

type Shown = {
  view: "single" | "all";
  patches: Held["patches"];
  folded: ReadonlySet<RangeFile>;
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let toLine: ReturnType<typeof vi.fn<() => void>>;
let unfoldFile: ReturnType<typeof vi.fn<(file: RangeFile) => void>>;
let onShown: ReturnType<typeof vi.fn<() => void>>;
let left: { current: Left | null };
let showing: ReviewThread | null;

function Files({ view, patches, folded }: Shown) {
  useFilesGoTo({
    held: {
      read: {
        kind: "ready",
        mergeBase: oid("a"),
        files: [file],
        contentMissing: false,
      },
      at: 0,
      patches,
    },
    files: {
      view,
      ref: { current: { toLine } },
      go: () => {},
    } as unknown as FilesChangedState,
    unfold: () => {},
    folded,
    unfoldFile,
    left,
    showing,
    onShown,
  });
  return null;
}

const show = (shown: Shown) =>
  act(async () => root.render(<Files {...shown} />));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  toLine = vi.fn();
  unfoldFile = vi.fn();
  onShown = vi.fn(() => {
    showing = null;
  });
  showing = thread as ReviewThread;
  left = { current: null };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("hands a line to the file's diff for when it draws, if its patch is still on its way", async () => {
  await show({ view: "single", patches: null, folded: new Set() });
  expect(toLine).not.toHaveBeenCalled();
  expect(left.current).toEqual({
    view: null,
    at: 0,
    line: { part: 0, side: "additions", number: 7, below: expect.any(Number) },
  });
});

it("goes to the line once All files has the patches", async () => {
  await show({ view: "all", patches: null, folded: new Set() });
  expect(toLine).not.toHaveBeenCalled();
  await show({
    view: "all",
    patches: new Map([[file, drawn]]),
    folded: new Set(),
  });
  expect(toLine).toHaveBeenCalledWith(0, {
    part: 0,
    side: "additions",
    number: 7,
  });
});

it("unfolds a folded or viewed file in All files before it goes to the line", async () => {
  const patches = new Map([[file, drawn]]);
  await show({ view: "all", patches, folded: new Set([file]) });
  expect(unfoldFile).toHaveBeenCalledWith(file);
  expect(toLine).not.toHaveBeenCalled();
  await show({ view: "all", patches, folded: new Set() });
  expect(toLine).toHaveBeenCalledTimes(1);
});
