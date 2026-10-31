import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  claimedWhilePaletteOpen,
  matchesShortcut,
  PALETTE_SHORTCUT,
  shortcutAction,
  typingIn,
} from "../actions";
import type { PaletteItem } from "../actions";
import type { Oid } from "../domain/repository";
import { mac } from "../repositories";
import { defineSlice } from "./actionSlices";
import type { ActionSlice, ComposedActions } from "./actionSlices";
import { focusedElement, shownElement } from "./dom";
import type { Focus } from "./useFocus";

export type Palette = {
  open: boolean;
  /** Stable, so the keydown listener registers once. */
  show: () => void;
  /** Closes, then returns focus to the element focused before it opened, else `focus.fallback()`. */
  close: () => void;
  run: (item: PaletteItem) => void;
  /** `typing` is false because a palette item never runs from a text field; the keydown handler sets it per event. */
  actions: ActionSlice<"picked" | "typing">;
};

export function usePalette({
  historyRef,
  fallback,
  refocusIfLost,
}: Pick<Focus, "historyRef" | "fallback" | "refocusIfLost">): Palette {
  const [palette, setPalette] = useState<{ picked: Oid | null } | null>(null);
  const paletteReturn = useRef<Element | null>(null);
  const show = useCallback(() => {
    paletteReturn.current = focusedElement();
    setPalette({ picked: historyRef.current?.picked() ?? null });
  }, [historyRef]);
  const close = () => {
    flushSync(() => setPalette(null));
    const back = paletteReturn.current;
    if (shownElement(back)) back.focus({ preventScroll: true });
    if (!shownElement(back) || focusedElement() !== back) fallback();
  };
  return {
    open: palette !== null,
    show,
    close,
    run: (item) => {
      close();
      item.run();
      refocusIfLost();
    },
    actions: defineSlice({
      context: { picked: palette?.picked ?? null, typing: false },
      commands: {},
    }),
  };
}

/**
 * The one global keydown listener: on `window`, in the bubble phase,
 * registered once. It reads the actions through a ref written in a layout
 * effect, so a key pressed right after a commit sees that commit's context.
 * Open dialogs come from the DOM and typing from `composedPath()[0]`; the
 * palette shortcut checks `event.target`.
 */
export function useShortcuts(
  actions: ComposedActions,
  palette: Pick<Palette, "open" | "show">,
) {
  const keys = useRef({ ...actions, palette: palette.open });
  useLayoutEffect(() => {
    keys.current = { ...actions, palette: palette.open };
  });
  const { show } = palette;
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const { context, commands, palette } = keys.current;
      // A modal dialog owns Escape, even when its focused control was disabled and dropped focus.
      const dialogOpen = document.querySelector("dialog[open]") !== null;
      if (matchesShortcut(PALETTE_SHORTCUT, event, mac)) {
        event.preventDefault();
        const target =
          event.target instanceof HTMLElement ? event.target : null;
        if (!dialogOpen && !typingIn(target)) show();
        return;
      }
      if (palette) {
        if (claimedWhilePaletteOpen(event, mac)) event.preventDefault();
        return;
      }
      const [origin] = event.composedPath();
      const typing = typingIn(origin instanceof HTMLElement ? origin : null);
      const action = shortcutAction(
        { ...context, dialogOpen, typing },
        event,
        mac,
      );
      if (action === null) return;
      event.preventDefault();
      action.run(commands);
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [show]);
}
