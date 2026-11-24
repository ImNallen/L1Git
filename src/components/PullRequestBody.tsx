import { Component, memo, Suspense, useState } from "react";
import type { ReactNode } from "react";
import { Markdown } from "../shell/lazyViews";

/** Whatever a text holds, reading it must not take the screen down. */
export class Plainly extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const LONG = 20_000;

function beginning(text: string) {
  const line = text.lastIndexOf("\n", LONG);
  return text.slice(0, line > 0 ? line : LONG);
}

/** Markdown from GitHub. Only the start of a very long one, until asked. */
export const Body = memo(function Body({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > LONG;
  const shown = long && !all ? beginning(text) : text;
  return (
    <div className="markdown">
      <Plainly
        key={shown}
        fallback={<pre className="markdown-plain">{shown}</pre>}
      >
        <Suspense>
          <Markdown text={shown} />
        </Suspense>
      </Plainly>
      {long && (
        <button
          type="button"
          className="pull-link"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
});
