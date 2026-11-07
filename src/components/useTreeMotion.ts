import { captureExit } from "../motionExit";
import { useEffect, useRef } from "react";
import type { SyntheticEvent } from "react";
import { captureLayout, cancelMotion, motionAllowed } from "../motion";

export function useTreeMotion() {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return (event: SyntheticEvent<HTMLElement>) => {
    const native = event.nativeEvent;
    if (!motionAllowed()) return;
    if (
      native instanceof KeyboardEvent &&
      !["ArrowLeft", "ArrowRight", "Enter", " "].includes(native.key)
    )
      return;
    const folder = native
      .composedPath()
      .find(
        (node) =>
          node instanceof HTMLElement &&
          node.matches('[role="treeitem"][aria-expanded]'),
      );
    if (!(folder instanceof HTMLElement)) return;
    const host = event.currentTarget;
    const root = host.shadowRoot;
    if (!root) return;
    const rows = () =>
      new Map(
        [
          ...root.querySelectorAll<HTMLElement>(
            '[role="treeitem"]:not([data-item-parked])',
          ),
        ].map((row) => [row.dataset.itemPath ?? row.id, row]),
      );
    const before = rows();
    const exits = new Map(
      [...before]
        .filter(
          ([key]) =>
            folder.getAttribute("aria-expanded") === "true" &&
            folder instanceof HTMLElement &&
            key !== folder.dataset.itemPath &&
            key.startsWith(folder.dataset.itemPath ?? "\0"),
        )
        .map(([key, row]) => [key, captureExit(row, "tree-row")]),
    );
    const from = captureLayout(before);
    cleanup.current?.();
    let pending: ReturnType<typeof captureLayout> | null = from;
    let expiry = 0;
    const cancel = () => {
      pending = null;
      window.clearTimeout(expiry);
      cancelMotion(rows());
      for (const exit of exits.values()) exit?.dispose();
    };
    expiry = window.setTimeout(() => {
      pending = null;
    }, 300);
    const observer = new MutationObserver((records) => {
      if (
        !pending ||
        !records.some((record) => record.attributeName === "aria-expanded")
      )
        return;
      const play = pending;
      pending = null;
      const after = rows();
      play(after, 220);
      for (const [key, exit] of exits) {
        if (after.has(key)) exit?.dispose();
        else exit?.play(220);
      }
    });
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });
    root.addEventListener("scroll", cancel, true);
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    media?.addEventListener("change", cancel);
    cleanup.current = () => {
      cancel();
      observer.disconnect();
      root.removeEventListener("scroll", cancel, true);
      media?.removeEventListener("change", cancel);
    };
  };
}
