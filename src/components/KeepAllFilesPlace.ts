import { Component } from "react";
import type { AllFilesKeeper } from "./allFilesKeeper";

type Props = {
  keeper: AllFilesKeeper;
  items: readonly unknown[];
  isShown: boolean;
  /** What Pierre drew has no height behind another tab. */
  onAppear: () => void;
  onLeave: () => void;
};

/** Tells the keeper of the place before Pierre has other files, and before it is hidden. */
export class KeepAllFilesPlace extends Component<Props> {
  getSnapshotBeforeUpdate(before: Props): null {
    const { keeper, items, isShown } = this.props;
    if (before.items !== items || (before.isShown && !isShown))
      keeper.remember();
    return null;
  }

  componentDidUpdate(before: Props) {
    const { keeper, items, isShown, onAppear } = this.props;
    const appears = isShown && !before.isShown;
    if (appears) onAppear();
    if (appears || before.items !== items) keeper.changed();
  }

  componentWillUnmount() {
    this.props.onLeave();
  }

  render() {
    return null;
  }
}
