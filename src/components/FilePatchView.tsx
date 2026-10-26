import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { MouseEvent, RefObject } from "react";
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import type { SelectedLineRange } from "@pierre/diffs";
import { FileX2, TriangleAlert } from "lucide-react";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { diffTheme } from "../themes/diffTheme";
import type { Appearance } from "../themes/palette";
import { hunkAnchor, parsedFiles } from "../domain/lineSelection";
import type { DiffStyle, HunkBar } from "../domain/lineSelection";
import type { PartAction } from "../domain/operations";
import type { FilePatch, LinePick } from "../domain/repository";

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

export function Diff({
  diff,
  diffStyle,
  theme,
  painted,
  parts = null,
}: {
  diff: FilePatch;
  diffStyle: DiffStyle;
  theme: Appearance;
  painted: boolean;
  parts?: Parts | null;
}) {
  if (diff.kind !== "text")
    return (
      <div className="file-diff-empty">
        <FileX2 size={28} />
        <p>
          {diff.kind === "binary"
            ? "Binary file. L1 Git does not display binary changes."
            : `This change is ${(diff.bytes / 1024 / 1024).toFixed(1)} MiB, above the 1 MiB display limit.`}
        </p>
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
        diffStyle={diffStyle}
        theme={theme}
        painted={painted}
        parts={parts}
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
  diffStyle,
  theme,
  painted,
  parts,
}: {
  patch: string;
  diffStyle: DiffStyle;
  theme: Appearance;
  painted: boolean;
  parts: Parts | null;
}) {
  const files = useMemo(() => parsedFiles(patch), [patch]);
  const latest = useRef(parts);
  latest.current = parts;
  const firstLineAction = useRef<HTMLButtonElement>(null);
  const writable = parts !== null;
  const firstHunk = files[0]?.hunks[0];
  const barOnTop =
    writable && firstHunk !== undefined && hunkAnchor(firstHunk, 0) === null;
  const options = useMemo(
    () =>
      ({
        theme: diffTheme(theme, painted),
        themeType: theme,
        diffStyle,
        disableFileHeader: !barOnTop,
        ...(writable && {
          enableLineSelection: true,
          enableGutterUtility: true,
          onLineSelectionEnd: (range: SelectedLineRange | null) =>
            latest.current?.onSelectRange(range),
          onGutterUtilityClick: (range: SelectedLineRange) =>
            gutterFirstAction(range),
        }),
      }) as const,
    [diffStyle, theme, painted, writable, barOnTop],
  );
  const pressed = useRef<{ hunk: number; action: PartAction } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  function gutterFirstAction(range: SelectedLineRange) {
    firstLineAction.current?.focus({ preventScroll: true });
    latest.current?.onGutterFirstAction(range);
  }
  const [firstAction] = parts?.actions ?? [];
  const gutterLabel = firstAction && lineLabels[firstAction];
  useEffect(function nameTheGutterPlus() {
    if (!gutterLabel) return;
    for (const host of scroll.current?.querySelectorAll(DIFFS_TAG_NAME) ?? [])
      host.shadowRoot
        ?.querySelector(GUTTER_PLUS)
        ?.setAttribute("aria-label", gutterLabel);
  });
  const pressGutterPlusByKey = (event: MouseEvent) => {
    const range = latest.current?.range;
    const onPlus = event.nativeEvent
      .composedPath()
      .some(
        (target) => target instanceof Element && target.matches(GUTTER_PLUS),
      );
    if (event.detail === 0 && onPlus && range) gutterFirstAction(range);
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
          {files.map((file, index) => (
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
          ))}
        </Virtualizer>
      </div>
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
    <div className="line-bar" role="toolbar" aria-label="Chosen lines">
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
