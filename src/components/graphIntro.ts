import { animate, motionAllowed } from "../motion";

const TIMELINE_MS = {
  cells: { from: 0.65, start: 100, end: 320 },
  nodes: { from: 0, start: 100, end: 280 },
  lanes: { start: 100, stagger: 80, staggerSpan: 160, duration: 480 },
  selection: { from: 0, start: 700, end: 880 },
  ring: {
    start: 700,
    faded: 880,
    overshot: 900,
    end: 1080,
    scale: [0.75, 1.12, 1],
  },
} as const;

export type LaneSegment = { lane: number; top: number; bottom: number };

const EASE_OUT_X2 = 0.58;

function easeOutTimeAtProgress(progress: number) {
  const t = 0.5 - Math.sin(Math.asin(1 - 2 * progress) / 3);
  return 3 * EASE_OUT_X2 * (1 - t) * t * t + t * t * t;
}

const FADE_IN = [{ opacity: 0 }, { opacity: 1 }];

function trimFrames(length: number) {
  const strokeDasharray = `${length} ${length}`;
  return [
    { strokeDasharray, strokeDashoffset: length },
    { strokeDasharray, strokeDashoffset: 0 },
  ];
}

export function planLaneDraw(segments: readonly LaneSegment[]) {
  const spans = new Map<number, { top: number; bottom: number }>();
  for (const { lane, top, bottom } of segments) {
    const span = spans.get(lane);
    spans.set(lane, {
      top: Math.min(top, span?.top ?? top),
      bottom: Math.max(bottom, span?.bottom ?? bottom),
    });
  }
  const { start, stagger, staggerSpan, duration } = TIMELINE_MS.lanes;
  const lanes = [...spans.keys()].sort((a, b) => a - b);
  const step =
    lanes.length > 1 ? Math.min(stagger, staggerSpan / (lanes.length - 1)) : 0;
  const starts = new Map(
    lanes.map((lane, rank) => [lane, start + rank * step]),
  );
  return segments.map(({ lane, top, bottom }) => {
    const span = spans.get(lane) ?? { top, bottom };
    const height = span.bottom - span.top || 1;
    const from = easeOutTimeAtProgress((top - span.top) / height);
    const to = easeOutTimeAtProgress((bottom - span.top) / height);
    return {
      delay: (starts.get(lane) ?? start) + duration * from,
      duration: duration * (to - from),
    };
  });
}

export function playGraphIntro(
  scroller: HTMLElement,
  rows: Iterable<HTMLElement>,
  selection: HTMLElement | null,
) {
  if (!motionAllowed() || typeof scroller.animate !== "function")
    return () => {};
  const animations: (Animation | undefined)[] = [];
  const fade = (
    element: HTMLElement | SVGElement,
    { from, start, end }: { from: number; start: number; end: number },
  ) =>
    animations.push(
      animate(element, [{ opacity: from }, { opacity: 1 }], end - start, {
        delay: start,
      }),
    );
  const { ring: track } = TIMELINE_MS;
  const ringDuration = track.end - track.start;
  const segments: (LaneSegment & { path: SVGPathElement })[] = [];
  for (const row of rows) {
    const rowTop = row.getBoundingClientRect().top;
    for (const cell of row.querySelectorAll<HTMLElement>(
      "td:not(.graph-column)",
    ))
      fade(cell, TIMELINE_MS.cells);
    for (const node of row.querySelectorAll<SVGElement>(
      '[data-graph-key="node"]',
    ))
      fade(node, TIMELINE_MS.nodes);
    for (const ring of row.querySelectorAll<SVGElement>(
      '[data-graph-key="ring"]',
    ))
      animations.push(
        animate(
          ring,
          [
            {
              offset: 0,
              opacity: 0,
              transform: `scale(${track.scale[0]})`,
              easing: "ease-out",
            },
            { offset: (track.faded - track.start) / ringDuration, opacity: 1 },
            {
              offset: (track.overshot - track.start) / ringDuration,
              transform: `scale(${track.scale[1]})`,
              easing: "ease-out",
            },
            { offset: 1, transform: `scale(${track.scale[2]})` },
          ],
          ringDuration,
          { delay: track.start, easing: "linear" },
        ),
      );
    for (const path of row.querySelectorAll<SVGPathElement>(
      "path[data-graph-lane]",
    )) {
      const box = path.getBBox();
      segments.push({
        path,
        lane: Number(path.dataset.graphLane),
        top: rowTop + box.y,
        bottom: rowTop + box.y + box.height,
      });
    }
  }
  for (const [index, timing] of planLaneDraw(segments).entries()) {
    const path = segments[index]?.path;
    if (!path) continue;
    const keepsDashPattern = path.hasAttribute("stroke-dasharray");
    const frames = keepsDashPattern
      ? FADE_IN
      : trimFrames(path.getTotalLength());
    animations.push(
      animate(path, frames, timing.duration, {
        delay: timing.delay,
        easing: "linear",
      }),
    );
  }
  if (selection) fade(selection, TIMELINE_MS.selection);

  const top = scroller.scrollTop;
  // Restoring a repository's scroll position fires one late event at this same offset.
  const scrolled = () => {
    if (scroller.scrollTop !== top) stop();
  };
  const stop = () => {
    for (const animation of animations) animation?.cancel();
    scroller.removeEventListener("scroll", scrolled);
    window.removeEventListener("resize", stop);
  };
  scroller.addEventListener("scroll", scrolled, { passive: true });
  window.addEventListener("resize", stop);
  void Promise.allSettled(animations.map((item) => item?.finished)).then(stop);
  return stop;
}
