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
    if (!folder) return;
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
    const from = captureLayout(rows());
    cleanup.current?.();
    let pending: ReturnType<typeof captureLayout> | null = from;
    let expiry = 0;
    const cancel = () => {
      pending = null;
      window.clearTimeout(expiry);
      cancelMotion(rows());
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
      play(rows(), 220);
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
