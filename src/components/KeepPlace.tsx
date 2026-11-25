import { Component } from "react";
import type { RefObject } from "react";

/** What a reader may be looking at, down to a paragraph. */
const PLACES =
  ".entry, .thread, .thread-comments > li, .markdown > *, .markdown-plain > *";
const LOOKS = 8;

type Place = { element: Element; top: number };

const topOf = (element: Element) => element.getBoundingClientRect().top;

/**
 * Places in the view, the nearest to its top first, unless the panel is at its
 * beginning. Looking at a few points takes as long in a panel of any length.
 */
function placesIn(panel: HTMLElement): Place[] {
  if (panel.scrollTop === 0) return [];
  const { left, top, width, height } = panel.getBoundingClientRect();
  const found = new Set<Element>();
  for (let look = 0; look < LOOKS; look += 1) {
    let place = document
      .elementsFromPoint(left + width / 2, top + 1 + (height * look) / LOOKS)
      .find((element) => panel.contains(element))
      ?.closest(PLACES);
    for (; place; place = place.parentElement?.closest(PLACES))
      found.add(place);
  }
  return [...found]
    .map((element) => ({ element, top: topOf(element) }))
    .sort(
      (left, right) => Math.abs(left.top - top) - Math.abs(right.top - top),
    );
}

/** WebKit keeps no place when what is above it grows or shrinks, so this does. */
export class KeepPlace extends Component<{
  panel: RefObject<HTMLElement | null>;
}> {
  private places: Place[] = [];
  // Each scroll is heard, and remembered, before a frame looks at sizes.
  private readonly sizes = new ResizeObserver(() => {
    this.restore(this.places);
    this.remember();
  });

  private get panel() {
    return this.props.panel.current;
  }

  private readonly remember = () => {
    const { panel } = this;
    if (!panel || panel.clientHeight === 0) return;
    this.places = placesIn(panel);
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
    this.sizes.disconnect();
    if (!panel) return;
    this.sizes.observe(panel);
    for (const child of panel.children) this.sizes.observe(child);
  }

  componentDidMount() {
    this.panel?.addEventListener("scroll", this.remember, { passive: true });
    this.observe();
  }

  getSnapshotBeforeUpdate(): Place[] {
    const { panel } = this;
    return panel && panel.clientHeight > 0 ? placesIn(panel) : this.places;
  }

  componentDidUpdate(_: unknown, __: unknown, places: Place[]) {
    this.restore(places);
    this.observe();
    this.remember();
  }

  componentWillUnmount() {
    this.sizes.disconnect();
    this.panel?.removeEventListener("scroll", this.remember);
  }

  render() {
    return null;
  }
}
