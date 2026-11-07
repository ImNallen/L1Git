import { captureExit } from "../motionExit";
import { captureLayout, cancelMotion, motionAllowed } from "../motion";
import type { MotionElements } from "../motion";
import type { DiffStyle } from "./FilePatchView";

function lines(root: HTMLElement): MotionElements {
  const result: MotionElements = new Map();
  for (const [file, host] of [
    ...root.querySelectorAll("diffs-container"),
  ].entries()) {
    const counters = new Map<string, number>();
    for (const line of host.shadowRoot?.querySelectorAll<HTMLElement>(
      "[data-line], [data-column-number], [data-separator], [data-content-buffer], [data-gutter-buffer]",
    ) ?? []) {
      const side =
        line.dataset.lineType === "change-deletion" ||
        line.closest("[data-deletions]")
          ? "old"
          : "new";
      const kind = line.hasAttribute("data-line")
        ? "code"
        : line.hasAttribute("data-column-number")
          ? "number"
          : line.hasAttribute("data-separator")
            ? "hunk"
            : line.hasAttribute("data-content-buffer")
              ? "content-fill"
              : "gutter-fill";
      const index = counters.get(`${side}:${kind}`) ?? 0;
      counters.set(`${side}:${kind}`, index + 1);
      const number =
        line.dataset.line ?? line.dataset.columnNumber ?? String(index);
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
  if (!motionAllowed()) {
    cancelPrevious?.();
    return () => {};
  }
  const offsets = hosts.map((host) => {
    const codes = [
      ...(host.shadowRoot?.querySelectorAll<HTMLElement>("[data-code]") ?? []),
    ];
    return codes.map((code) =>
      Number(code.dataset.motionScroll ?? code.scrollLeft),
    );
  });
  const scroller = root.querySelector<HTMLElement>(".file-diff-scroll");
  const expectedScroll = scroller?.scrollTop ?? 0;
  const before = lines(root);
  const viewport = scroller?.getBoundingClientRect();
  const anchor = [...before].find(
    ([key, line]) =>
      key.includes(":new:code:") &&
      viewport &&
      line.getBoundingClientRect().top >= viewport.top,
  );
  const anchorY = anchor?.[1].getBoundingClientRect().y;
  const exits = new Map(
    [...before].map(([key, line]) => [key, captureExit(line, "diff-line")]),
  );
  const play = captureLayout(before);
  cancelPrevious?.();
  let finish = 0;
  const restore = () => {
    for (const host of hosts) {
      host.removeAttribute("data-layout-motion");
      for (const code of host.shadowRoot?.querySelectorAll<HTMLElement>(
        "[data-code]",
      ) ?? []) {
        code.style.removeProperty("--motion-columns");
        code.style.removeProperty("--motion-scroll");
        if (code.dataset.motionScroll !== undefined)
          code.scrollLeft = Number(code.dataset.motionScroll);
        delete code.dataset.motionScroll;
      }
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
    if (scroller) {
      const target = anchor && lines(root).get(anchor[0]);
      scroller.scrollTop =
        target && anchorY !== undefined
          ? scroller.scrollTop + target.getBoundingClientRect().y - anchorY
          : expectedScroll;
    }
    for (const [index, host] of hosts.entries()) {
      for (const code of host.shadowRoot?.querySelectorAll<HTMLElement>(
        "[data-code]",
      ) ?? []) {
        const requestedOffset =
          offsets[index]?.[
            code.hasAttribute("data-deletions")
              ? 0
              : (offsets[index]?.length ?? 1) - 1
          ] ?? 0;
        const offset = Math.min(
          requestedOffset,
          Math.max(0, code.scrollWidth - code.clientWidth),
        );
        code.dataset.motionScroll = String(offset);
        code.style.setProperty("--motion-scroll", `${-offset}px`);
        code.style.setProperty(
          "--motion-columns",
          getComputedStyle(code).gridTemplateColumns,
        );
      }
      host.setAttribute("data-layout-motion", "");
    }
    const after = lines(root);
    play(after, 200);
    for (const [key, exit] of exits) {
      if (after.has(key)) exit?.dispose();
      else exit?.play(200);
    }
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
    for (const exit of exits.values()) exit?.dispose();
  };
  const pointer = (event: PointerEvent) => {
    if (event.target === scroller) cancel();
  };
  const key = (event: KeyboardEvent) => {
    if (
      ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(
        event.key,
      )
    )
      cancel();
  };
  root.addEventListener("pointerdown", pointer, true);
  root.addEventListener("keydown", key, true);
  root.addEventListener("wheel", cancel, true);
  root.addEventListener("touchmove", cancel, true);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", cancel);
  const timeout = window.setTimeout(() => observer.disconnect(), 500);
  return () => {
    cancel();
    window.clearTimeout(timeout);
    root.removeEventListener("pointerdown", pointer, true);
    root.removeEventListener("keydown", key, true);
    root.removeEventListener("wheel", cancel, true);
    root.removeEventListener("touchmove", cancel, true);
    media.removeEventListener("change", cancel);
  };
}
