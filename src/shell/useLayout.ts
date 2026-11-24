import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { browserStorage, readStored, writeStored } from "../persisted";
import { COMMIT_SUMMARY_ID } from "../components/CommitBox";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { WorkspaceView } from "./workspaceView";

// Below this the default sidebar leaves the history too narrow for its columns.
const NARROW_SIDEBAR = "(max-width: 939px)";

const PANE_WIDTHS_KEY = "l1git.paneWidths.v1";
export const SIDEBAR_WIDTH = { min: 210, max: 400, initial: 280 } as const;
export const INSPECTOR_WIDTH = { min: 280, max: 500, initial: 360 } as const;
const paneWidthsSchema = z.object({
  version: z.literal(1),
  sidebar: z.number().int().min(SIDEBAR_WIDTH.min).max(SIDEBAR_WIDTH.max),
  inspector: z.number().int().min(INSPECTOR_WIDTH.min).max(INSPECTOR_WIDTH.max),
});
type PaneWidths = { sidebar: number; inspector: number };
type Pane = keyof PaneWidths;

function restorePaneWidths(
  storage: Pick<Storage, "getItem"> | null,
): PaneWidths {
  const saved = readStored(storage, PANE_WIDTHS_KEY, paneWidthsSchema);
  return saved
    ? { sidebar: saved.sidebar, inspector: saved.inspector }
    : { sidebar: SIDEBAR_WIDTH.initial, inspector: INSPECTOR_WIDTH.initial };
}

export type ToolbarMenuKind =
  | "fetch"
  | "pull"
  | "push"
  | "branch"
  | "stash"
  | "more";
type ToolbarMenu = { kind: ToolbarMenuKind; anchor: HTMLButtonElement };

/**
 * Pane open state and widths. The toggle refs live here because the toggle
 * commands focus their button, which WebKit does not do on click, and the
 * focus fallback focuses the sidebar toggle.
 */
export type Layout = {
  searchSlot: HTMLDivElement | null;
  setSearchSlot: (element: HTMLDivElement | null) => void;
  toolbarMenu: ToolbarMenu | null;
  setToolbarMenu: (menu: ToolbarMenu | null) => void;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  /** Open, with a commit to inspect. */
  inspectorVisible: boolean;
  paneWidths: PaneWidths;
  resizePane: (pane: Pane, width: number) => void;
  savePaneWidth: (pane: Pane, width: number) => void;
  persistenceError: string | null;
  sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  inspectorToggleRef: RefObject<HTMLButtonElement | null>;
  openInspector: () => void;
  actions: ActionSlice<
    "inspectable",
    "toggleSidebar" | "toggleInspector" | "focusCommit"
  >;
};

export function useLayout(shown: WorkspaceView["shown"]): Layout {
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  const [toolbarMenu, setToolbarMenu] = useState<ToolbarMenu | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia(NARROW_SIDEBAR).matches,
  );
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.innerWidth >= 1100,
  );
  const [paneWidths, setPaneWidths] = useState(() =>
    restorePaneWidths(browserStorage()),
  );
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1099px)");
    const narrow = () => {
      if (media.matches) setInspectorOpen(false);
    };
    media.addEventListener("change", narrow);
    return () => media.removeEventListener("change", narrow);
  }, []);
  useEffect(() => {
    const media = window.matchMedia(NARROW_SIDEBAR);
    const narrow = () => {
      if (media.matches) setSidebarOpen(false);
    };
    media.addEventListener("change", narrow);
    return () => media.removeEventListener("change", narrow);
  }, []);
  return {
    searchSlot,
    setSearchSlot,
    toolbarMenu,
    setToolbarMenu,
    sidebarOpen,
    inspectorOpen,
    inspectorVisible: Boolean(shown && inspectorOpen),
    paneWidths,
    resizePane: (pane, width) =>
      setPaneWidths((widths) => ({ ...widths, [pane]: width })),
    savePaneWidth: (pane, width) => {
      const next = { ...paneWidths, [pane]: width };
      setPaneWidths(next);
      setPersistenceError(
        writeStored(
          browserStorage(),
          PANE_WIDTHS_KEY,
          { version: 1, ...next },
          "Pane widths changed for this session. Could not save them.",
        ),
      );
    },
    persistenceError,
    sidebarToggleRef,
    inspectorToggleRef,
    openInspector: () => setInspectorOpen(true),
    actions: defineSlice({
      context: { inspectable: shown !== null },
      commands: {
        toggleSidebar: () => {
          flushSync(() => setSidebarOpen((open) => !open));
          sidebarToggleRef.current?.focus();
        },
        toggleInspector: () => {
          flushSync(() => setInspectorOpen((open) => !open));
          inspectorToggleRef.current?.focus();
        },
        focusCommit: () => {
          flushSync(() => setInspectorOpen(true));
          document.getElementById(COMMIT_SUMMARY_ID)?.focus();
        },
      },
    }),
  };
}
