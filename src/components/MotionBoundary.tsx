import { Component } from "react";
import type { ReactNode } from "react";

export type MotionSnapshot = {
  play: () => void;
  dispose: () => void;
  takeExit?: () => HTMLElement | null;
};

type Props<Identity> = {
  identity: Identity;
  ready?: boolean;
  afterLayout?: boolean;
  capture: (
    previous: Identity,
    active: MotionSnapshot | null,
  ) => MotionSnapshot | null;
  children?: ReactNode;
};

/** React runs this before DOM mutations, including on interrupted animations. */
export class MotionBoundary<Identity = string | null> extends Component<
  Props<Identity>
> {
  private active: MotionSnapshot | null = null;
  private pending = false;

  getSnapshotBeforeUpdate(previous: Props<Identity>) {
    if (previous.identity === this.props.identity) return null;
    const snapshot = this.props.capture(previous.identity, this.active);
    if (snapshot !== this.active) this.active?.dispose();
    this.active = snapshot;
    this.pending = snapshot !== null;
    return snapshot;
  }

  componentDidUpdate() {
    if (this.pending && this.props.ready !== false) {
      this.pending = false;
      const active = this.active;
      const play = () => {
        if (this.active === active) active?.play();
      };
      if (this.props.afterLayout) queueMicrotask(play);
      else play();
    }
  }

  componentWillUnmount() {
    this.active?.dispose();
    this.active = null;
  }

  render() {
    return this.props.children;
  }
}
