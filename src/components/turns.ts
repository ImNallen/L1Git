import { createContext } from "react";
import { flushSync } from "react-dom";

const FRAME_MS = 8;
/**
 * About how many elements there are at once, besides those near the view. All
 * of 100 long texts took 1.3 GB, and 3 s of each resize of the window.
 */
const ROOM = 40_000;

export type Turn = {
  place: Element;
  /** What to show next, if it is time for it, and how many elements it is then. */
  next: (isNear: boolean) => { weight: number; show: () => void } | null;
  /** Shows nothing again, in as much space. */
  putAway: () => void;
};

/** What is focused or selected is not put away. */
function isHeld(place: Element): boolean {
  if (place.contains(document.activeElement)) return true;
  const selection = getSelection();
  return (
    selection?.isCollapsed === false &&
    selection.getRangeAt(0).intersectsNode(place)
  );
}

/**
 * Shows what there is to show a few places at a time, the ones near the view
 * first, so that no frame has to lay out all of them.
 */
export class Turns {
  private turns = new Map<Element, Turn>();
  private near = new Set<Element>();
  private weights = new Map<Element, number>();
  private total = 0;
  private sight: IntersectionObserver | null = null;
  private frame = 0;

  readonly isNear = (place: Element) => this.near.has(place);

  /** Returns how to leave. */
  join(turn: Turn): () => void {
    const { place } = turn;
    this.sight ??= new IntersectionObserver(this.look, {
      root: place.closest(".file-diff-scroll, .pull-panel"),
      rootMargin: "50% 0px",
    });
    this.turns.set(place, turn);
    this.sight.observe(place);
    this.wake();
    return () => {
      this.turns.delete(place);
      this.near.delete(place);
      this.weigh(place, 0);
      this.sight?.unobserve(place);
    };
  }

  /** Looks again at who may have something to show. */
  readonly wake = () => {
    if (this.frame === 0) this.frame = requestAnimationFrame(this.take);
  };

  private weightOf(place: Element) {
    return this.weights.get(place) ?? 0;
  }

  private weigh(place: Element, weight: number) {
    this.total += weight - this.weightOf(place);
    if (weight > 0) this.weights.set(place, weight);
    else this.weights.delete(place);
  }

  private readonly look = (entries: IntersectionObserverEntry[]) => {
    for (const { target, isIntersecting } of entries) {
      const turn = this.turns.get(target);
      if (!turn) continue;
      if (isIntersecting) this.near.add(target);
      else this.near.delete(target);
    }
    this.wake();
  };

  private readonly take = () => {
    this.frame = 0;
    const end = performance.now() + FRAME_MS;
    const all = [...this.turns.values()];
    const near = all.filter(({ place }) => this.isNear(place));
    const far = all.filter(({ place }) => !this.isNear(place));
    for (const { place, next } of [...near, ...far]) {
      // Another step may have taken it away.
      if (!this.turns.has(place)) continue;
      const isNear = this.isNear(place);
      for (let step = next(isNear); step; step = next(isNear)) {
        const total = this.total - this.weightOf(place) + step.weight;
        if (!isNear && total > ROOM) break;
        if (performance.now() >= end) return this.wake();
        flushSync(step.show);
        this.weigh(place, step.weight);
        // Laying it out takes most of the time.
        place.getBoundingClientRect();
      }
    }
    this.makeRoom();
  };

  private makeRoom() {
    for (const place of this.weights.keys()) {
      if (this.total <= ROOM) break;
      if (this.isNear(place) || isHeld(place)) continue;
      this.turns.get(place)?.putAway();
      this.weigh(place, 0);
    }
  }
}

export const TurnsContext = createContext(new Turns());
