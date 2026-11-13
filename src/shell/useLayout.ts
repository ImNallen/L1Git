import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import { COMMIT_SUMMARY_ID } from "../components/CommitBox";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { WorkspaceView } from "./workspaceView";

// Below this the default sidebar leaves the history too narrow for its columns.
const NARROW_SIDEBAR = "(max-width: 939px)";

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
  inspectorVisible: boolean;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
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
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [inspectorWidth, setInspectorWidth] = useState(360);
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
    inspectorVisible: Boolean(shown && inspectorOpen),
    sidebarWidth,
    setSidebarWidth,
    inspectorWidth,
    setInspectorWidth,
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
