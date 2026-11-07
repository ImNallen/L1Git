import { useRef } from "react";
import type { RefObject } from "react";
import { animate, cancelMotion } from "../motion";
import { captureExit } from "../motionExit";

export function useRepositoryMotion(
  container: RefObject<HTMLElement | null>,
  root: string | null,
  selector?: string,
) {
  const visited = useRef(false);
  const element = () =>
    selector
      ? container.current?.querySelector<HTMLElement>(selector)
      : container.current;
  return {
    identity: root,
    capture: (previous: string | null) => {
      const first = previous === null && !visited.current;
      if (previous !== null || root !== null) visited.current = true;
      if (first) return null;
      const old = element();
      if (!old) return null;
      const exit = captureExit(old, "repository");
      let focusRing: HTMLDivElement | null = null;
      const clearFocus = () => {
        focusRing?.remove();
        focusRing = null;
        window.removeEventListener("focusin", clearFocus, true);
        window.removeEventListener("scroll", clearFocus, true);
        window.removeEventListener("resize", clearFocus);
      };
      return {
        play: () => {
          exit?.play(170);
          const next = element();
          if (next) {
            const focused = document.activeElement;
            if (
              focused instanceof HTMLElement &&
              next.contains(focused) &&
              focused.matches(":focus-visible")
            ) {
              const target = focused.querySelector("tr.selected") ?? focused;
              const rect = target.getBoundingClientRect();
              focusRing = document.createElement("div");
              focusRing.inert = true;
              focusRing.setAttribute("aria-hidden", "true");
              focusRing.style.cssText = `position:fixed;pointer-events:none;z-index:101;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;outline:var(--focus-ring);outline-offset:var(--focus-ring-offset)`;
              document.body.append(focusRing);
              window.addEventListener("focusin", clearFocus, true);
              window.addEventListener("scroll", clearFocus, true);
              window.addEventListener("resize", clearFocus);
            }
            const animation = animate(
              next,
              [{ opacity: 0 }, { opacity: 1 }],
              170,
            );
            if (animation) animation.finished.then(clearFocus, clearFocus);
            else clearFocus();
          }
        },
        dispose: () => {
          clearFocus();
          exit?.dispose();
          const next = element();
          if (next) cancelMotion(new Map([["repository", next]]));
        },
      };
    },
  };
}
