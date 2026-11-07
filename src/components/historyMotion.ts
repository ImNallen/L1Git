import { useLayoutEffect, useMemo } from "react";
import type { RefObject } from "react";
import type { MotionSnapshot } from "./MotionBoundary";
import type { HistoryRow } from "../domain/worktree";
import type { RepositoryRoot } from "../domain/repository";
import type { Graph, RowId } from "../domain/graph";
import { animate, cancelMotion, captureLayout, motionAllowed } from "../motion";
import { captureExit } from "../motionExit";

type Identity = {
  root: RepositoryRoot;
  rows: readonly HistoryRow[];
  graph: Graph;
  selected: RowId | null;
  template: string;
  hidden: boolean;
};
type Geometry = { element: SVGElement; attribute: "cx" | "d"; value: string };
const numbers = /-?\d*\.?\d+(?:e[+-]?\d+)?/gi;

function geometry(rows: Map<string, HTMLElement>) {
  const result = new Map<string, Geometry>();
  for (const [id, row] of rows)
    for (const element of row.querySelectorAll<SVGElement>(
      "[data-graph-key]",
    )) {
      const attribute = element.tagName.toLowerCase() === "circle" ? "cx" : "d";
      const value = element.getAttribute(attribute);
      if (value !== null)
        result.set(`${id}:${element.dataset.graphKey}`, {
          element,
          attribute,
          value,
        });
    }
  return result;
}

function moveGeometry(
  before: Map<string, Geometry>,
  after: Map<string, Geometry>,
) {
  const tracks: { target: Geometry; from: number[]; to: number[] }[] = [];
  for (const [key, target] of after) {
    const old = before.get(key);
    if (!old || old.value === target.value) continue;
    if (old.value.replace(numbers, "#") !== target.value.replace(numbers, "#"))
      continue;
    const from = [...old.value.matchAll(numbers)].map((match) =>
      Number(match[0]),
    );
    const to = [...target.value.matchAll(numbers)].map((match) =>
      Number(match[0]),
    );
    if (from.length === to.length) tracks.push({ target, from, to });
  }
  if (!tracks.length || !motionAllowed()) return () => {};
  let frame = 0;
  const started = performance.now();
  const paint = (progress: number) => {
    let low = 0;
    let high = 1;
    for (let index = 0; index < 12; index++) {
      const t = (low + high) / 2;
      const x = 3 * (1 - t) * t * t * 0.58 + t * t * t;
      if (x < progress) low = t;
      else high = t;
    }
    const t = (low + high) / 2;
    const eased =
      progress === 0 ? 0 : progress === 1 ? 1 : 3 * t * t - 2 * t * t * t;
    for (const { target, from, to } of tracks) {
      let index = 0;
      target.element.setAttribute(
        target.attribute,
        target.value.replace(numbers, () => {
          const start = from[index] ?? 0;
          const end = to[index++] ?? start;
          return String(start + (end - start) * eased);
        }),
      );
    }
  };
  const tick = () => {
    const progress = Math.min(1, (performance.now() - started) / 220);
    paint(progress);
    if (progress < 1) frame = requestAnimationFrame(tick);
  };
  paint(0);
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    for (const { target } of tracks)
      target.element.setAttribute(target.attribute, target.value);
  };
}

export function useHistoryMotion(
  identity: Identity,
  scroll: RefObject<HTMLDivElement | null>,
  marker: RefObject<HTMLDivElement | null>,
) {
  const { root, rows, graph, selected, template, hidden } = identity;
  const token = useMemo(
    () => ({ root, rows, graph, selected, template, hidden }),
    [root, rows, graph, selected, template, hidden],
  );
  const nextIds = useMemo(
    () => new Set<string>(rows.map((row) => row.id)),
    [rows],
  );
  const mounted = () => {
    const result = new Map<string, HTMLElement>();
    const viewport = scroll.current?.getBoundingClientRect();
    if (!viewport?.height || !viewport.width) return result;
    for (const row of scroll.current?.querySelectorAll<HTMLElement>(
      "[data-motion-row]",
    ) ?? []) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > viewport.top + 32 && rect.top < viewport.bottom)
        result.set(row.dataset.motionRow ?? row.id, row);
    }
    return result;
  };
  const positionMarker = () => {
    const scroller = scroll.current;
    const paint = marker.current;
    const row = scroller?.querySelector<HTMLElement>(
      'tr[aria-selected="true"]',
    );
    if (!scroller || !paint) return;
    if (!row || hidden) {
      paint.hidden = true;
      delete scroller.dataset.selectionPainted;
      return;
    }
    const rect = row.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    const shift = (element: Element | null) => {
      const values = element
        ? getComputedStyle(element).translate.split(" ")
        : [];
      return {
        x: Number.parseFloat(values[0] ?? "0") || 0,
        y: Number.parseFloat(values[1] ?? "0") || 0,
      };
    };
    const rowShift = shift(row);
    const bodyShift = shift(row.closest("tbody"));
    paint.hidden = false;
    paint.style.top = `${rect.top - bounds.top + scroller.scrollTop - rowShift.y - bodyShift.y}px`;
    paint.style.left = `${rect.left - bounds.left + scroller.scrollLeft - rowShift.x - bodyShift.x}px`;
    paint.style.width = `${rect.width}px`;
    paint.style.height = `${rect.height}px`;
    scroller.dataset.selectionPainted = "";
  };
  useLayoutEffect(positionMarker);
  useLayoutEffect(() => {
    const scroller = scroll.current;
    if (!scroller) return;
    const observer = new ResizeObserver(positionMarker);
    observer.observe(scroller);
    return () => observer.disconnect();
  });
  return {
    identity: token,
    afterLayout: true,
    capture(previous: Identity): MotionSnapshot | null {
      if (
        previous.root !== root ||
        previous.hidden ||
        hidden ||
        !motionAllowed()
      )
        return null;
      const oldRows = mounted();
      const scrollTop = scroll.current?.scrollTop;
      const scrollLeft = scroll.current?.scrollLeft;
      const changed =
        previous.rows !== rows ||
        previous.graph !== graph ||
        previous.template !== template;
      const oldGeometry = geometry(oldRows);
      const oldCells = new Map(
        [...oldRows].map(([id, row]) => [
          id,
          {
            row: row.getBoundingClientRect(),
            cells: [...row.querySelectorAll("td")].map((cell) => ({
              key: cell.className,
              x: cell.getBoundingClientRect().x,
            })),
          },
        ]),
      );
      const oldMarker =
        marker.current && !marker.current.hidden
          ? marker.current.getBoundingClientRect()
          : null;
      const playRows = captureLayout(oldRows, { animateWidth: false });
      const exits = [...oldRows]
        .filter(([id]) => !nextIds.has(id))
        .map(([, row]) => captureExit(row, "history-row"));
      let stopGeometry = () => {};
      let animated = new Map<string, HTMLElement>();
      let attached = false;
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      const dispose = () => {
        stopGeometry();
        cancelMotion(animated);
        for (const exit of exits) exit?.dispose();
        scroll.current?.removeEventListener("scroll", dispose);
        window.removeEventListener("resize", dispose);
        media.removeEventListener("change", dispose);
        attached = false;
      };
      return {
        play() {
          positionMarker();
          const next = mounted();
          const nextGeometry = geometry(next);
          const cells: { cell: HTMLElement; x: number }[] = [];
          for (const [id, row] of next) {
            const old = oldCells.get(id);
            if (!old) continue;
            const rect = row.getBoundingClientRect();
            for (const cell of row.querySelectorAll<HTMLTableCellElement>(
              "td:not(.graph-column)",
            )) {
              const before = old.cells.find(
                (entry) => entry.key === cell.className,
              );
              if (before)
                cells.push({
                  cell,
                  x:
                    before.x -
                    old.row.x -
                    (cell.getBoundingClientRect().x - rect.x),
                });
            }
          }
          const paint = marker.current;
          const newMarker =
            paint && !paint.hidden ? paint.getBoundingClientRect() : null;
          if (
            scroll.current?.scrollTop === scrollTop &&
            scroll.current?.scrollLeft === scrollLeft
          )
            playRows(
              changed
                ? next
                : new Map([...next].filter(([key]) => oldRows.has(key))),
              220,
            );
          animated = new Map(next);
          for (const [index, { cell, x }] of cells.entries())
            if (x) {
              animate(
                cell,
                [{ translate: `${x}px 0` }, { translate: "0px 0px" }],
                220,
              );
              animated.set(`cell:${index}`, cell);
            }
          if (paint && newMarker && oldMarker) {
            const view = scroll.current?.getBoundingClientRect();
            const visible =
              view &&
              oldMarker.bottom > view.top + 32 &&
              oldMarker.top < view.bottom;
            if (visible)
              animate(
                paint,
                [
                  {
                    translate: `${oldMarker.x - newMarker.x}px ${oldMarker.y - newMarker.y}px`,
                  },
                  { translate: "0px 0px" },
                ],
                220,
              );
            animated.set("selection", paint);
          }
          stopGeometry = moveGeometry(oldGeometry, nextGeometry);
          for (const exit of exits) exit?.play(220);
          if (!attached) {
            scroll.current?.addEventListener("scroll", dispose, {
              passive: true,
            });
            window.addEventListener("resize", dispose);
            media.addEventListener("change", dispose);
            attached = true;
          }
        },
        dispose,
      };
    },
  };
}
