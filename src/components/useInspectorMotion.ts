import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { animate, captureLayout } from "../motion";

export function useInspectorMotion(
  container: RefObject<HTMLElement | null>,
  root: string,
  commit: string | null,
) {
  const previous = useRef<{
    root: string;
    commit: string;
    play: ReturnType<typeof captureLayout>;
  } | null>(null);
  useLayoutEffect(() => {
    if (!commit || !container.current) return;
    const elements = new Map<string, HTMLElement>();
    for (const selector of [
      ".commit-information > .sha-chip",
      ".commit-information > h2",
      ".inspector-refs",
      ".commit-message-section",
      ".commit-information > .commit-metadata",
      ".changed-files-section",
    ]) {
      const element = container.current.querySelector<HTMLElement>(selector);
      if (element) elements.set(selector, element);
    }
    const last = previous.current;
    if (last?.root === root && last.commit === commit) return;
    previous.current = { root, commit, play: captureLayout(elements) };
    if (last?.root === root) {
      last.play(elements, 220);
      const title = container.current.querySelector<HTMLElement>("h2");
      if (title) animate(title, [{ opacity: 0 }, { opacity: 1 }], 220);
    } else if (last)
      animate(container.current, [{ opacity: 0 }, { opacity: 1 }], 170);
  }, [container, root, commit]);
}
