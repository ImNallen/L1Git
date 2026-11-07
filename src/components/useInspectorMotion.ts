import type { RefObject } from "react";
import { animate, captureLayout, cancelMotion } from "../motion";

export function useInspectorMotion(
  container: RefObject<HTMLElement | null>,
  root: string,
  commit: string | null,
) {
  const elements = () => {
    const result = new Map<string, HTMLElement>();
    for (const selector of [
      ".commit-information > .sha-chip",
      ".commit-information > h2",
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
    identity: commit === null ? null : `${root}:${commit}`,
    capture: (previous: string | null) => {
      if (previous !== null && !previous.startsWith(`${root}:`)) return null;
      const play = captureLayout(elements());
      return {
        play: () => {
          const next = elements();
          play(next, 220);
          const title = next.get(".commit-information > h2");
          if (title) animate(title, [{ opacity: 0 }, { opacity: 1 }], 220);
        },
        dispose: () => cancelMotion(elements()),
      };
    },
  };
}
