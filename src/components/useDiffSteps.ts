import { useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { Ref, RefObject } from "react";
import { VirtualizedFileDiff } from "@pierre/diffs";
import type { FileDiffMetadata, VirtualFileMetrics } from "@pierre/diffs";
import { changeStops, scrollToChange } from "../domain/changeStops";

const LINE = 22;
/** What Pierre reckons with until it has measured, as the stylesheet has it. */
export const reviewMetrics: VirtualFileMetrics = {
  // In batches of more lines, Pierre leaves the last ones of some diffs blank.
  hunkLineCount: 1,
  lineHeight: LINE,
  diffHeaderHeight: 0,
  hunkSeparatorHeight: 32,
  spacing: 0,
};

const ABOVE_CHANGE = 3 * LINE;

export type DrawnPart = {
  node: HTMLElement;
  instance: VirtualizedFileDiff<unknown>;
};

/** What Pierre scrolls a diff in, which it makes itself. */
export const scrollerIn = (body: RefObject<HTMLElement | null>) =>
  body.current?.querySelector<HTMLElement>(".file-diff-scroll") ?? null;

/** The parts of a patch as Pierre drew them. */
export function useDrawnParts() {
  const drawn = useRef(new Map<HTMLElement, VirtualizedFileDiff<unknown>>());
  const onPostRender = useCallback((node: HTMLElement, instance: object) => {
    if (instance instanceof VirtualizedFileDiff)
      drawn.current.set(node, instance);
  }, []);
  const parts = useCallback(
    (): DrawnPart[] =>
      [...drawn.current]
        .filter(([node]) => node.isConnected)
        .map(([node, instance]) => ({ node, instance }))
        .sort((left, right) =>
          left.node.compareDocumentPosition(right.node) &
          Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
        ),
    [],
  );
  return { onPostRender, parts };
}

export type DiffSteps = {
  /** Scrolls to the next change or the one before. False when there is none. */
  step: (by: 1 | -1) => boolean;
};

export function useDiffSteps(
  ref: Ref<DiffSteps> | undefined,
  body: RefObject<HTMLElement | null>,
  patch: readonly FileDiffMetadata[],
  parts: () => DrawnPart[],
  startsAtEnd: boolean,
) {
  const scroll = useCallback(
    (by: 1 | -1, from?: number): boolean => {
      const scroller = scrollerIn(body);
      if (!scroller) return false;
      const drawn = parts();
      const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
      const tops = changeStops(patch).flatMap(({ part, side, line }) => {
        const { node, instance } = drawn[part] ?? {};
        const place = instance?.getLinePosition(line, side);
        return node && place
          ? node.getBoundingClientRect().top - origin + place.top
          : [];
      });
      const view = {
        at: from ?? scroller.scrollTop,
        most: scroller.scrollHeight - scroller.clientHeight,
        above: ABOVE_CHANGE,
      };
      const to = scrollToChange(tops, view, by);
      if (to !== null) scroller.scrollTop = to;
      return to !== null;
    },
    [body, patch, parts],
  );
  useImperativeHandle(ref, () => ({ step: (by) => scroll(by) }), [scroll]);
  useEffect(() => {
    if (startsAtEnd) scroll(-1, Infinity);
  }, [startsAtEnd, scroll]);
}
