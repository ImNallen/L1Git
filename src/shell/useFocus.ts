import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { FileDiffHandle } from "../components/FileDiffPane";
import type { HistoryHandle } from "../components/History";
import { focusedElement, shownElement } from "./dom";

/**
 * Where focus goes when its element disappears: History, then the open diff,
 * then the sidebar toggle. History's and FileDiffPane's own focus effects
 * assume this order.
 */
export type Focus = {
  historyRef: RefObject<HistoryHandle | null>;
  fileDiffRef: RefObject<FileDiffHandle | null>;
  /** Stable. The first of History, the diff, and the sidebar toggle that ends up focused and shown. */
  fallback: () => void;
  /** On the next frame, `fallback()` unless a shown element has focus. */
  refocusIfLost: () => void;
  /** Unless a shown element has focus, the sidebar's current branch row, else `fallback()`. */
  focusNamedBranch: () => void;
  /** Asks `useFocusRecovery` for a lost-focus check after the next commit. */
  checkLost: () => void;
  lostFocusChecks: number;
};

export function useFocus(
  sidebarToggleRef: RefObject<HTMLButtonElement | null>,
): Focus {
  const [lostFocusChecks, setLostFocusChecks] = useState(0);
  const historyRef = useRef<HistoryHandle>(null);
  const fileDiffRef = useRef<FileDiffHandle>(null);
  const fallback = useCallback(() => {
    for (const focus of [
      () => historyRef.current?.focus(),
      () => fileDiffRef.current?.focus(),
      () => sidebarToggleRef.current?.focus(),
    ]) {
      focus();
      if (shownElement(focusedElement())) return;
    }
  }, [sidebarToggleRef]);
  return {
    historyRef,
    fileDiffRef,
    fallback,
    refocusIfLost: () =>
      requestAnimationFrame(() => {
        if (!shownElement(focusedElement())) fallback();
      }),
    focusNamedBranch: () => {
      if (shownElement(focusedElement())) return;
      const named = document.querySelector<HTMLElement>(
        ".repository-tree .branch-row[aria-current='true']",
      );
      if (named) named.focus();
      else fallback();
    },
    checkLost: () => setLostFocusChecks((count) => count + 1),
    lostFocusChecks,
  };
}

/**
 * Separate from `useFocus` so App can call it after the ref-step effect: when
 * both fire in one commit, that effect must see the lost focus first or it
 * skips jumping to the restored branch.
 */
export function useFocusRecovery({
  lostFocusChecks,
  fallback,
}: Pick<Focus, "lostFocusChecks" | "fallback">) {
  useEffect(() => {
    if (lostFocusChecks > 0 && !shownElement(focusedElement())) fallback();
  }, [lostFocusChecks, fallback]);
}
