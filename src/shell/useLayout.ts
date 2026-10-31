import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import { COMMIT_SUMMARY_ID } from "../components/CommitBox";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { WorkspaceView } from "./workspaceView";

// Below this the default sidebar leaves the history too narrow for its columns.
const NARROW_SIDEBAR = "(max-width: 939px)";

/**
 * Pane open state and widths. Each toggle renders in one of two places and
 * refocuses whichever instance is mounted after `flushSync`, so its ref is
 * shared and owned here rather than by the toggle.
 */
export type Layout = {
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
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia(NARROW_SIDEBAR).matches,
  );
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.innerWidth >= 1100,
  );
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [inspectorWidth, setInspectorWidth] = useState(320);
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
        toggleSidebar: () => setSidebarOpen((open) => !open),
        toggleInspector: () => setInspectorOpen((open) => !open),
        focusCommit: () => {
          flushSync(() => setInspectorOpen(true));
          document.getElementById(COMMIT_SUMMARY_ID)?.focus();
        },
      },
    }),
  };
}
