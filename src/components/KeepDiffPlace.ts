import { Component } from "react";
import type { RefObject } from "react";
import type { DiffStyle } from "../domain/lineSelection";
import { reviewMetrics, scrollerIn } from "./useDiffSteps";
import type { DrawnPart } from "./useDiffSteps";

type Place = {
  scrollTop: number;
  /** The first line in the view, and how far below its top. */
  line: {
    part: number;
    side: "deletions" | "additions";
    number: number;
    below: number;
  } | null;
};

/** Pierre measures what it drew in the frame after. */
const STILL_FRAMES = 3;
const MOST_FRAMES = 30;

const sideOf = (line: HTMLElement) =>
  line.dataset.lineType === "change-deletion" ||
  line.closest("[data-deletions]")
    ? "deletions"
    : "additions";

const linesOf = ({ node }: DrawnPart) => [
  ...(node.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []),
];

function placeIn(scroller: HTMLElement, parts: readonly DrawnPart[]): Place {
  const { scrollTop } = scroller;
  // At its beginning, what comes before the first line is to be seen.
  if (scrollTop === 0) return { scrollTop, line: null };
  const { top, bottom } = scroller.getBoundingClientRect();
  for (const [part, drawn] of parts.entries())
    for (const line of linesOf(drawn)) {
      const bounds = line.getBoundingClientRect();
      if (bounds.bottom <= top) continue;
      if (bounds.top >= bottom) return { scrollTop, line: null };
      return {
        scrollTop,
        line: {
          part,
          side: sideOf(line),
          number: Number(line.dataset.line),
          below: bounds.top - top,
        },
      };
    }
  return { scrollTop, line: null };
}

/** How far to scroll so that a place is where it was, and whether it is drawn. */
function distanceTo(
  { scrollTop, line }: Place,
  scroller: HTMLElement,
  parts: readonly DrawnPart[],
): { by: number; isDrawn: boolean } {
  const drawn = line && parts[line.part];
  const back = scrollTop - scroller.scrollTop;
  if (!drawn) return { by: back, isDrawn: true };
  const { top } = scroller.getBoundingClientRect();
  const shown = linesOf(drawn).find(
    (each) =>
      Number(each.dataset.line) === line.number && sideOf(each) === line.side,
  );
  if (shown)
    return {
      by: shown.getBoundingClientRect().top - top - line.below,
      isDrawn: true,
    };
  const place = drawn.instance.getLinePosition(line.number, line.side);
  return {
    by: place
      ? drawn.node.getBoundingClientRect().top + place.top - top - line.below
      : back,
    isDrawn: false,
  };
}

type Props = {
  body: RefObject<HTMLElement | null>;
  parts: () => DrawnPart[];
  isShown: boolean;
  diffStyle: DiffStyle;
};

/**
 * Keeps the place in a diff while what is above it changes, behind another tab
 * or screen, and from one layout to the other.
 */
export class KeepDiffPlace extends Component<Props> {
  private place: Place | null = null;
  private frame = 0;
  private scroller: HTMLElement | null = null;
  private readonly sizes = new ResizeObserver(() => {
    this.follow(this.place);
  });

  private get shown(): HTMLElement | null {
    const { scroller } = this;
    return scroller !== null && scroller.clientHeight > 0 ? scroller : null;
  }

  private readonly remember = () => {
    if (this.shown) this.place = placeIn(this.shown, this.props.parts());
  };

  /** Whether the place is where it was. */
  private restore(place: Place): boolean {
    const { shown } = this;
    if (!shown) return true;
    const { by, isDrawn } = distanceTo(place, shown, this.props.parts());
    if (Math.abs(by) < 1) return isDrawn;
    shown.scrollTop += by;
    return false;
  }

  /** Without a line, whatever moves is what Pierre moved. */
  private follow(place: Place | null) {
    if (this.frame === 0 && place?.line) this.restore(place);
  }

  private readonly stop = () => {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.scroller?.style.removeProperty("visibility");
  };

  /** Over the frames in which Pierre lays out again. */
  private settle(place: Place, still = 0, frames = 0) {
    this.stop();
    const now = this.restore(place) ? still + 1 : 0;
    if (now < STILL_FRAMES && frames < MOST_FRAMES) {
      // Another place would flash by.
      if (now === 0) this.scroller?.style.setProperty("visibility", "hidden");
      this.frame = requestAnimationFrame(() =>
        this.settle(place, now, frames + 1),
      );
    } else this.remember();
  }

  componentDidMount() {
    const scroller = scrollerIn(this.props.body);
    this.scroller = scroller;
    if (!scroller) return;
    scroller.addEventListener("scroll", this.remember, { passive: true });
    // A reader who scrolls has another place.
    for (const event of ["wheel", "pointerdown", "keydown", "touchmove"])
      scroller.addEventListener(event, this.stop, { passive: true });
    this.sizes.observe(scroller);
    for (const child of scroller.children) this.sizes.observe(child);
  }

  getSnapshotBeforeUpdate(): Place | null {
    return this.frame === 0 && this.shown
      ? placeIn(this.shown, this.props.parts())
      : this.place;
  }

  componentDidUpdate(before: Props, _: unknown, place: Place | null) {
    const { isShown, diffStyle, parts } = this.props;
    if (!isShown) {
      this.stop();
      this.place = place;
      return;
    }
    const appears = !before.isShown;
    if (place && (appears || diffStyle !== before.diffStyle)) {
      // Pierre measured a hidden diff as having no height.
      for (const { instance } of appears ? parts() : []) {
        instance.setMetrics(reviewMetrics, true);
        instance.rerender();
      }
      this.settle(place);
    } else if (this.frame === 0) {
      this.follow(place);
      this.remember();
    }
  }

  componentWillUnmount() {
    this.stop();
    this.sizes.disconnect();
  }

  render() {
    return null;
  }
}
