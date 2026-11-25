import { Component } from "react";
import type { CodeView } from "@pierre/diffs";
import type { FileNote } from "./useFileItems";

type Side = "deletions" | "additions";
export type AllFilesPlace = {
  id: string;
  /** The first line in the view, or null where a file begins or has none. */
  line: { side: Side; number: number } | null;
  /** How far it is below the top of the view. */
  below: number;
};

/** What comes first in the view under the pinned header. */
function placeInView(
  viewer: CodeView<FileNote>,
  header: number,
): AllFilesPlace | null {
  const scrollTop = viewer.getScrollTop();
  for (const { id, type, instance } of viewer.getRenderedItems()) {
    const top = viewer.getTopForItem(id);
    if (top === undefined) continue;
    const below = top - scrollTop;
    if (below >= 0) return { id, line: null, below };
    if (below + instance.getVirtualizedHeight() <= header) continue;
    const anchor =
      type === "diff" ? instance.getNumericScrollAnchor(header - below) : null;
    if (anchor)
      return {
        id,
        line: {
          side: anchor.side ?? "additions",
          number: anchor.lineNumber,
        },
        below: below + anchor.top,
      };
    return { id, line: null, below };
  }
  return null;
}

export function scrollToPlace(
  viewer: CodeView<FileNote>,
  { id, line, below }: AllFilesPlace,
  header: number,
) {
  viewer.scrollTo(
    line
      ? {
          type: "line",
          id,
          lineNumber: line.number,
          side: line.side,
          offset: below - header,
        }
      : { type: "item", id, offset: below },
  );
}

type Props = {
  viewer: () => CodeView<FileNote> | undefined;
  header: number;
  isShown: boolean;
  /** What Pierre drew has no height behind another tab, and its place is lost. */
  onAppear: (place: AllFilesPlace | null) => void;
  onLeave: (place: AllFilesPlace | null) => void;
};

/**
 * Keeps the place behind another tab or screen. Pierre keeps it by itself
 * while what is above it changes, and from one layout to the other.
 */
export class KeepAllFilesPlace extends Component<Props> {
  private place: AllFilesPlace | null = null;

  private look(): AllFilesPlace | null {
    const viewer = this.props.viewer();
    return viewer ? placeInView(viewer, this.props.header) : null;
  }

  getSnapshotBeforeUpdate(before: Props): null {
    if (before.isShown && !this.props.isShown) this.place = this.look();
    return null;
  }

  componentDidUpdate(before: Props) {
    if (!before.isShown && this.props.isShown) this.props.onAppear(this.place);
  }

  componentWillUnmount() {
    this.props.onLeave(this.props.isShown ? this.look() : this.place);
  }

  render() {
    return null;
  }
}
