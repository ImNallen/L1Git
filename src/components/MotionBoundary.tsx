import { Component } from "react";
import type { ReactNode } from "react";

export type MotionSnapshot = { play: () => void; dispose: () => void };

type Props = {
  identity: string | null;
  capture: (previous: string | null) => MotionSnapshot | null;
  children?: ReactNode;
};

/** React runs this before DOM mutations, including on interrupted animations. */
export class MotionBoundary extends Component<Props> {
  private active: MotionSnapshot | null = null;

  getSnapshotBeforeUpdate(previous: Props) {
    if (previous.identity === this.props.identity) return null;
    const snapshot = this.props.capture(previous.identity);
    this.active?.dispose();
    this.active = snapshot;
    return snapshot;
  }

  componentDidUpdate(
    _previous: Props,
    _state: unknown,
    snapshot: MotionSnapshot | null,
  ) {
    snapshot?.play();
  }

  componentWillUnmount() {
    this.active?.dispose();
  }

  render() {
    return this.props.children;
  }
}
