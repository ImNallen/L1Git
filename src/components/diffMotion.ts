import { captureLayout, cancelMotion, motionAllowed } from "../motion";
import type { MotionElements } from "../motion";
import type { DiffStyle } from "./FilePatchView";

function lines(root: HTMLElement): MotionElements {
  const result: MotionElements = new Map();
  for (const [file, host] of [
    ...root.querySelectorAll("diffs-container"),
  ].entries()) {
    for (const line of host.shadowRoot?.querySelectorAll<HTMLElement>(
      "[data-line], [data-column-number]",
    ) ?? []) {
      const side =
        line.dataset.lineType === "change-deletion" ||
        line.closest("[data-deletions]")
          ? "old"
          : "new";
      const kind = line.hasAttribute("data-line") ? "code" : "number";
      const number = line.dataset.line ?? line.dataset.columnNumber;
      result.set(`${file}:${side}:${kind}:${number}`, line);
    }
  }
  return result;
}

export function prepareDiffMotion(
  root: HTMLElement,
  style: DiffStyle,
  cancelPrevious: (() => void) | null,
) {
  const hosts = [...root.querySelectorAll("diffs-container")];
  const scrolled = hosts.some((host) =>
    [
      ...(host.shadowRoot?.querySelectorAll<HTMLElement>("[data-code]") ?? []),
    ].some((code) => code.scrollLeft !== 0),
  );
  if (!motionAllowed() || scrolled) {
    cancelPrevious?.();
    return () => {};
  }
  const play = captureLayout(lines(root));
  cancelPrevious?.();
  let finish = 0;
  const restore = () => {
    for (const host of hosts) {
      host.removeAttribute("data-layout-motion");
      for (const code of host.shadowRoot?.querySelectorAll<HTMLElement>(
        "[data-code]",
      ) ?? [])
        code.style.removeProperty("--motion-columns");
    }
  };
  const observer = new MutationObserver(() => {
    const hosts = [...root.querySelectorAll("diffs-container")];
    if (
      !hosts.length ||
      !hosts.every((host) =>
        host.shadowRoot?.querySelector(
          `[data-diff-type="${style === "unified" ? "single" : "split"}"]`,
        ),
      )
    )
      return;
    observer.disconnect();
    for (const host of hosts) {
      for (const code of host.shadowRoot?.querySelectorAll<HTMLElement>(
        "[data-code]",
      ) ?? [])
        code.style.setProperty(
          "--motion-columns",
          getComputedStyle(code).gridTemplateColumns,
        );
      host.setAttribute("data-layout-motion", "");
    }
    play(lines(root), 200);
    finish = window.setTimeout(restore, 200);
  });
  for (const host of root.querySelectorAll("diffs-container")) {
    if (host.shadowRoot)
      observer.observe(host.shadowRoot, {
        childList: true,
        subtree: true,
        attributes: true,
      });
  }
  const cancel = () => {
    observer.disconnect();
    window.clearTimeout(finish);
    restore();
    cancelMotion(lines(root));
  };
  root.addEventListener("scroll", cancel, true);
  root.addEventListener("wheel", cancel, true);
  root.addEventListener("touchmove", cancel, true);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", cancel);
  const timeout = window.setTimeout(() => observer.disconnect(), 500);
  return () => {
    cancel();
    window.clearTimeout(timeout);
    root.removeEventListener("scroll", cancel, true);
    root.removeEventListener("wheel", cancel, true);
    root.removeEventListener("touchmove", cancel, true);
    media.removeEventListener("change", cancel);
  };
}
