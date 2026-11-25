import { Component } from "react";
import type { ReactNode } from "react";
import { FilesState } from "./FilesState";

type Props = { url: string; onRetry?: () => void; children: ReactNode };

/** Whatever fails while the files are drawn, the rest of the app stays. */
export class FilesBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    const { url, onRetry, children } = this.props;
    if (!this.state.failed) return children;
    return (
      <FilesState
        title="Couldn't show the changes"
        url={url}
        onRetry={() => {
          onRetry?.();
          this.setState({ failed: false });
        }}
      >
        <p role="alert">Something went wrong while drawing them.</p>
      </FilesState>
    );
  }
}
