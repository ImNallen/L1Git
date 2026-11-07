import type { RefObject } from "react";
import type { MotionSnapshot } from "./MotionBoundary";
import { animate, captureLayout, cancelMotion } from "../motion";

export function useInspectorMotion(
  container: RefObject<HTMLElement | null>,
  root: string,
  commit: string | null,
  requested: string | null = commit,
) {
  const elements = () => {
    const result = new Map<string, HTMLElement>();
    for (const selector of [
      ".commit-information > .sha-chip",
      ".commit-information h2",
      ".inspector-refs",
      ".commit-message-section",
      ".commit-information > .commit-metadata",
      ".changed-files-section",
    ]) {
      const element = container.current?.querySelector<HTMLElement>(selector);
      if (element) result.set(selector, element);
    }
    return result;
  };
  return {
    identity: requested === null ? null : `${root}:${requested}`,
    ready: commit !== null && commit === requested,
    afterLayout: true,
    capture: (previous: string | null, active: MotionSnapshot | null) => {
      if (previous !== null && !previous.startsWith(`${root}:`)) return null;
      const current = elements();
      if (current.size === 0 && active) return active;
      const play = captureLayout(current, { animateWidth: false });
      return {
        play: () => {
          const next = elements();
          play(next, 220);
          const title = next.get(".commit-information h2");
          if (title) animate(title, [{ opacity: 0 }, { opacity: 1 }], 220);
        },
        dispose: () => cancelMotion(elements()),
      };
    },
  };
}
