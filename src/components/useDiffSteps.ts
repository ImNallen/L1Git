import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import type { Ref, RefObject } from "react";
import { keyExpanders } from "./expanders";
import { VirtualizedFileDiff } from "@pierre/diffs";
import type { FileDiffMetadata, VirtualFileMetrics } from "@pierre/diffs";
import { changeStops, nextChange } from "../domain/changeStops";

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

/** What to leave over a change. */
export const ABOVE_CHANGE = 3 * LINE;

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
    keyExpanders(node);
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
  /** Scrolls to where the current file begins. */
  toStart: (at: number) => void;
  /** Says which file is current, if it knows better. */
  tell?: () => void;
};

export function useDiffSteps(
  ref: Ref<DiffSteps> | undefined,
  body: RefObject<HTMLElement | null>,
  patch: readonly FileDiffMetadata[],
  parts: () => DrawnPart[],
  startsAtEnd: boolean,
) {
  const stops = useMemo(() => changeStops(patch), [patch]);
  const scroll = useCallback(
    (by: 1 | -1, from?: number): boolean => {
      const scroller = scrollerIn(body);
      if (!scroller) return false;
      const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
      const drawn = parts().map(({ node, instance }) => ({
        instance,
        top: node.getBoundingClientRect().top - origin,
      }));
      const topOf = (stop: number) => {
        const { part, side, line } = stops[stop] ?? { part: -1 };
        const { instance, top = 0 } = drawn[part] ?? {};
        return (
          top +
          (line === undefined
            ? 0
            : (instance?.getLinePosition(line, side)?.top ?? 0))
        );
      };
      const view = {
        at: from ?? scroller.scrollTop,
        most: scroller.scrollHeight - scroller.clientHeight,
        above: ABOVE_CHANGE,
      };
      const to = nextChange(stops.length, topOf, view, by);
      if (to) scroller.scrollTop = to.scrollTop;
      return to !== null;
    },
    [body, stops, parts],
  );
  useImperativeHandle(
    ref,
    () => ({
      step: (by) => scroll(by),
      toStart: () => scrollerIn(body)?.scrollTo({ top: 0 }),
    }),
    [scroll, body],
  );
  useEffect(() => {
    if (startsAtEnd) scroll(-1, Infinity);
  }, [startsAtEnd, scroll]);
}
