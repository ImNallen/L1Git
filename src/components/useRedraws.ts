import { useEffect, useReducer, useState } from "react";
import { flushSync } from "react-dom";

/** How many times in a row a drawing that keeps failing is tried again. */
const MOST_TRIES = 3;
/** After this long without a failure, it may fail as many times again. */
const CALM_MS = 1_000;

/** What Pierre draws in place of a file it failed to draw. */
const FAILED = "[data-error-wrapper]";

/** What WebKit and Chromium report, with no error, when sizes change again
 * inside a ResizeObserver callback. Nothing failed, so nothing is redrawn. */
const RESIZE_NOTICE =
  "ResizeObserver loop completed with undelivered notifications.";

const isNotice = (event: ErrorEvent) =>
  event.error === null && event.message === RESIZE_NOTICE;

/** Calls `redraw` once Pierre is done with the frame, still before it shows. */
function onFailure(redraw: () => void) {
  let tries = 0;
  let failedAt = -Infinity;
  let isQueued = false;
  return () => {
    const time = performance.now();
    if (time - failedAt > CALM_MS) tries = 0;
    failedAt = time;
    if (isQueued || tries >= MOST_TRIES) return;
    tries += 1;
    isQueued = true;
    queueMicrotask(() => {
      isQueued = false;
      flushSync(redraw);
    });
  };
}

const watching = (failed: () => void) => (node: HTMLElement) => {
  if (node.shadowRoot?.querySelector(FAILED)) failed();
};

/**
 * For `onPostRender` in the options of all files: a new one after a drawing
 * failed, so that all is drawn anew before the frame shows. New options have
 * Pierre draw every file in view in full, where it otherwise draws only the
 * lines that came into view.
 *
 * Pierre (diffs 1.6.4) fails so when the view gets lower: it cuts lines off
 * both ends of a file it drew, and where one side of a split is a single gap
 * past both ends, it cuts that gap at one end only and throws "split columns
 * out of sync". It catches that itself and leaves the file empty.
 */
export function useRedraws() {
  const [failed] = useState(() => onFailure(() => redraw()));
  const [drawn, redraw] = useReducer(() => watching(failed), failed, watching);
  // What Pierre throws in its own frames, outside of a file.
  useEffect(() => {
    const heard = (event: ErrorEvent) => {
      if (!isNotice(event)) failed();
    };
    addEventListener("error", heard);
    return () => removeEventListener("error", heard);
  }, [failed]);
  return drawn;
}
