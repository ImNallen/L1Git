import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { MouseEvent, ReactNode, Ref, RefObject } from "react";
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { FileX2, TriangleAlert } from "lucide-react";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type { Appearance } from "../themes/palette";
import { sidesFor, undrawn } from "../domain/fileSides";
import { hunkAnchor, parsedFiles } from "../domain/lineSelection";
import type { DiffStyle, HunkBar } from "../domain/lineSelection";
import type { PartAction } from "../domain/operations";
import type { FilePatch, LinePick } from "../domain/repository";
import type { ThreadsOnLine } from "../domain/reviewThreads";
import { KeepDiffPlace } from "./KeepDiffPlace";
import { patchOptions } from "./patchOptions";
import { reviewMetrics, useDiffSteps, useDrawnParts } from "./useDiffSteps";
import type { DiffSteps } from "./useDiffSteps";

export type { DiffStyle };

export type Parts = {
  actions: readonly PartAction[];
  busy: boolean;
  range: SelectedLineRange | null;
  picks: readonly LinePick[];
  onSelectRange: (range: SelectedLineRange | null) => void;
  onHunk: (action: PartAction, hunk: number) => void;
  onLines: (action: PartAction) => void;
  onGutterFirstAction: (range: SelectedLineRange) => void;
  onLostFocus: () => void;
};

/** What a review shows with a diff, in one place to scroll. */
export type Review = {
  ref: Ref<DiffSteps>;
  startsAtEnd: boolean;
  isShown: boolean;
  above: ReactNode;
  below: ReactNode;
  /** For each part of the patch. */
  onLines: readonly ThreadsOnLine[][];
  renderThreads: (ids: readonly string[]) => ReactNode;
};

type WholeRead = () => Promise<string>;

export function Diff({
  diff,
  whole,
  diffStyle,
  theme,
  painted,
  parts = null,
  review = null,
}: {
  diff: FilePatch;
  whole: WholeRead;
  diffStyle: DiffStyle;
  theme: Appearance;
  painted: boolean;
  parts?: Parts | null;
  review?: Review | null;
}) {
  if (diff.kind !== "text")
    return (
      <div className="file-diff-empty">
        <FileX2 size={28} />
        <p>{undrawn(diff)}</p>
      </div>
    );
  return (
    <>
      {diff.lossy && (
        <div className="notice error-notice" role="status">
          <TriangleAlert size={14} />
          <span>
            This file is not valid UTF-8. Bytes that are not UTF-8 appear as �,
            so some changed lines can look identical.
          </span>
        </div>
      )}
      <Patch
        patch={diff.patch}
        whole={whole}
        diffStyle={diffStyle}
        theme={theme}
        painted={painted}
        parts={parts}
        review={review}
      />
    </>
  );
}

const GUTTER_PLUS = "[data-utility-button]";

const hunkLabels: Record<PartAction, string> = {
  stage: "Stage hunk",
  unstage: "Unstage hunk",
  discard: "Discard hunk…",
};
const lineLabels: Record<PartAction, string> = {
  stage: "Stage lines",
  unstage: "Unstage lines",
  discard: "Discard lines…",
};

function Patch({
  patch,
  whole,
  diffStyle,
  theme,
  painted,
  parts,
  review,
}: {
  patch: string;
  whole: WholeRead;
  diffStyle: DiffStyle;
  theme: Appearance;
  painted: boolean;
  parts: Parts | null;
  review: Review | null;
}) {
  const files = useMemo(() => parsedFiles(patch), [patch]);
  const latest = useRef(parts);
  latest.current = parts;
  const latestWhole = useRef(whole);
  latestWhole.current = whole;
  const firstLineAction = useRef<HTMLButtonElement>(null);
  const writable = parts !== null;
  const firstHunk = files[0]?.hunks[0];
  const barOnTop =
    writable && firstHunk !== undefined && hunkAnchor(firstHunk, 0) === null;
  const scroll = useRef<HTMLDivElement>(null);
  const { onPostRender, parts: drawnParts } = useDrawnParts();
  useDiffSteps(
    review?.ref,
    scroll,
    files,
    drawnParts,
    review?.startsAtEnd === true,
  );
  const options = useMemo(
    () =>
      ({
        ...patchOptions(theme, painted),
        diffStyle,
        diffIndicators: "classic",
        hunkSeparators: "line-info-basic",
        disableFileHeader: !barOnTop,
        onPostRender,
        loadDiffFiles: async (fileDiff: FileDiffMetadata) =>
          sidesFor(fileDiff, await latestWhole.current()),
        ...(writable && {
          enableLineSelection: true,
          enableGutterUtility: true,
          onLineSelectionEnd: (range: SelectedLineRange | null) =>
            latest.current?.onSelectRange(range),
          onGutterUtilityClick: (range: SelectedLineRange) =>
            gutterFirstAction(range),
        }),
      }) as const,
    [diffStyle, theme, painted, writable, barOnTop, onPostRender],
  );
  const pressed = useRef<{ hunk: number; action: PartAction } | null>(null);
  function gutterFirstAction(range: SelectedLineRange) {
    firstLineAction.current?.focus({ preventScroll: true });
    latest.current?.onGutterFirstAction(range);
  }
  const [firstAction] = parts?.actions ?? [];
  const gutterLabel = firstAction && lineLabels[firstAction];
  const range = parts?.range;
  useEffect(
    function nameTheGutterPlus() {
      if (!gutterLabel) return;
      for (const host of scroll.current?.querySelectorAll(DIFFS_TAG_NAME) ?? [])
        host.shadowRoot
          ?.querySelector(GUTTER_PLUS)
          ?.setAttribute("aria-label", gutterLabel);
    },
    [gutterLabel, range, options],
  );
  const pressGutterPlusByKey = (event: MouseEvent) => {
    const chosen = latest.current?.range;
    if (event.detail !== 0 || !chosen) return;
    const onPlus = event.nativeEvent
      .composedPath()
      .some(
        (target) => target instanceof Element && target.matches(GUTTER_PLUS),
      );
    if (onPlus) gutterFirstAction(chosen);
  };
  useLayoutEffect(
    function refocusTheNextHunkBar() {
      const after = pressed.current;
      pressed.current = null;
      const focused = document.activeElement;
      if (after === null || (focused !== null && focused !== document.body))
        return;
      const bars = scroll.current?.querySelectorAll("[data-hunk-bar]") ?? [];
      const bar = bars[Math.min(after.hunk, bars.length - 1)];
      const button =
        bar?.querySelector<HTMLElement>(`[data-action="${after.action}"]`) ??
        bar?.querySelector<HTMLElement>("button");
      if (button) button.focus();
      else latest.current?.onLostFocus();
    },
    [files],
  );
  const bar = (hunk: number, count: number) =>
    parts && (
      <div
        className="hunk-bar"
        role="group"
        aria-label={`Hunk ${hunk + 1} of ${count}`}
        data-hunk-bar={hunk}
      >
        <span className="hunk-bar-label">
          Hunk {hunk + 1} of {count}
        </span>
        {parts.actions.map((action) => (
          <button
            key={action}
            className="hunk-bar-button"
            data-action={action}
            aria-disabled={parts.busy}
            onClick={() => {
              if (parts.busy) return;
              pressed.current = { hunk, action };
              parts.onHunk(action, hunk);
            }}
          >
            {hunkLabels[action]}
          </button>
        ))}
      </div>
    );
  if (files.every((file) => file.hunks.length === 0)) {
    const moved = files.find(
      (file) => file.prevName !== undefined && file.prevName !== file.name,
    );
    return (
      <div className="file-diff-empty">
        <p>
          {moved
            ? `${/^copy from /m.test(patch) ? "Copied" : "Renamed"} from ${moved.prevName}. The content did not change.`
            : "No content changes. Only the file mode or an empty file changed."}
        </p>
      </div>
    );
  }
  return (
    <>
      {parts && <LineBar parts={parts} firstAction={firstLineAction} />}
      <div
        ref={scroll}
        className="file-diff-body"
        onClick={pressGutterPlusByKey}
      >
        <Virtualizer className="file-diff-scroll">
          {review?.above}
          {files.map((file, index) =>
            review ? (
              <FileDiff<readonly string[]>
                key={index}
                fileDiff={file}
                options={options}
                metrics={reviewMetrics}
                lineAnnotations={review.onLines[index]}
                renderAnnotation={({ metadata }) =>
                  review.renderThreads(metadata)
                }
              />
            ) : (
              <FileDiff<HunkBar>
                key={index}
                fileDiff={file}
                options={options}
                {...(parts && {
                  selectedLines: parts.range,
                  lineAnnotations: file.hunks.flatMap(
                    (hunk, at) => hunkAnchor(hunk, at) ?? [],
                  ),
                  renderAnnotation: ({ metadata: { hunk } }) =>
                    bar(hunk, file.hunks.length),
                  ...(barOnTop && {
                    renderCustomHeader: () => bar(0, file.hunks.length),
                  }),
                })}
              />
            ),
          )}
          {review?.below}
        </Virtualizer>
      </div>
      {review && (
        <KeepDiffPlace
          body={scroll}
          parts={drawnParts}
          isShown={review.isShown}
          diffStyle={diffStyle}
        />
      )}
    </>
  );
}

function LineBar({
  parts,
  firstAction,
}: {
  parts: Parts;
  firstAction: RefObject<HTMLButtonElement | null>;
}) {
  const { range, picks, busy, actions } = parts;
  const count = picks.length;
  const off = busy || count === 0;
  return (
    <div className="line-bar" role="group" aria-label="Chosen lines">
      <span className="line-bar-text" role="status">
        {range === null
          ? "Click a line number to choose lines. Shift-click to extend."
          : count === 0
            ? "The chosen lines hold no change."
            : `${count.toLocaleString()} changed ${count === 1 ? "line" : "lines"} chosen.`}
      </span>
      {actions.map((action, index) => (
        <button
          key={action}
          ref={index === 0 ? firstAction : undefined}
          className="button secondary"
          aria-disabled={off}
          onClick={() => {
            if (!off) parts.onLines(action);
          }}
        >
          {lineLabels[action]}
        </button>
      ))}
      <button
        className="button secondary"
        aria-disabled={range === null}
        onClick={() => parts.onSelectRange(null)}
      >
        Clear
      </button>
    </div>
  );
}
