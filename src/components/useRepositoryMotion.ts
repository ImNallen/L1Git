import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { animate } from "../motion";

export function useRepositoryMotion(
  container: RefObject<HTMLElement | null>,
  root: string | null,
  selector?: string,
) {
  const previous = useRef(root);
  useLayoutEffect(() => {
    if (root === null) return;
    if (
      previous.current !== null &&
      root !== previous.current &&
      container.current
    ) {
      const element = selector
        ? container.current.querySelector<HTMLElement>(selector)
        : container.current;
      if (element && !element.contains(document.activeElement))
        animate(element, [{ opacity: 0 }, { opacity: 1 }], 170);
    }
    previous.current = root;
  }, [container, root, selector]);
}
