import { Component } from "react";
import type { RefObject } from "react";

/** What a reader may be looking at, down to a paragraph. */
const PLACES = ".entry, .thread, .thread-comments > li, .markdown > *";
const REMEMBERED = 8;

type Place = { element: Element; top: number };

const topOf = (element: Element) => element.getBoundingClientRect().top;

/** The places nearest to the top of the panel, unless it is at its beginning. */
function placesIn(panel: HTMLElement): Place[] {
  if (panel.scrollTop === 0) return [];
  const bounds = panel.getBoundingClientRect();
  return [...panel.querySelectorAll(PLACES)]
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }))
    .filter(
      ({ bounds: { top, bottom } }) =>
        bottom > bounds.top && top < bounds.bottom,
    )
    .map(({ element, bounds: { top } }) => ({ element, top }))
    .sort(
      (left, right) =>
        Math.abs(left.top - bounds.top) - Math.abs(right.top - bounds.top),
    )
    .slice(0, REMEMBERED);
}

/** WebKit keeps no place when what is above it grows or shrinks, so this does. */
export class KeepPlace extends Component<{
  panel: RefObject<HTMLElement | null>;
}> {
  private places: Place[] = [];
  private scrollTop = 0;
  private observed: HTMLElement | null = null;
  private frame = 0;
  private readonly sizes = new ResizeObserver(() => {
    const { panel } = this;
    // A scroll that has not been remembered yet is the reader's own.
    if (panel?.scrollTop === this.scrollTop) this.restore(this.places);
    this.remember();
  });

  private get panel() {
    return this.props.panel.current;
  }

  private readonly remember = () => {
    const { panel } = this;
    if (!panel || panel.clientHeight === 0) return;
    this.places = placesIn(panel);
    this.scrollTop = panel.scrollTop;
  };

  private readonly scrolled = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.remember);
  };

  private restore(places: readonly Place[]) {
    const { panel } = this;
    const place = places.find(({ element }) => panel?.contains(element));
    if (!panel || !place || panel.clientHeight === 0) return;
    const moved = topOf(place.element) - place.top;
    if (Math.abs(moved) >= 1) panel.scrollTop += moved;
  }

  private observe() {
    const { panel } = this;
    if (panel !== this.observed) {
      this.observed?.removeEventListener("scroll", this.scrolled);
      panel?.addEventListener("scroll", this.scrolled, { passive: true });
      this.observed = panel;
      this.places = [];
    }
    this.sizes.disconnect();
    if (!panel) return;
    this.sizes.observe(panel);
    for (const child of panel.children) this.sizes.observe(child);
  }

  componentDidMount() {
    this.observe();
  }

  getSnapshotBeforeUpdate(): Place[] {
    const { panel } = this;
    return panel ? placesIn(panel) : [];
  }

  componentDidUpdate(_: unknown, __: unknown, places: Place[]) {
    this.restore(places);
    this.observe();
    this.remember();
  }

  componentWillUnmount() {
    this.sizes.disconnect();
    this.observed?.removeEventListener("scroll", this.scrolled);
    cancelAnimationFrame(this.frame);
  }

  render() {
    return null;
  }
}
