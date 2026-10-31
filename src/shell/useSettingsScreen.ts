import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import type { Screen, SettingsSection } from "../actions";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { Layout } from "./useLayout";

export type SettingsScreen = {
  screen: Screen;
  section: SettingsSection;
  setSection: (section: SettingsSection) => void;
  settingsRef: RefObject<HTMLButtonElement | null>;
  /** Back to the repository screen, focusing Settings, or the sidebar toggle while the sidebar is closed. */
  leave: () => void;
  /** Back to the repository screen without moving focus. */
  toRepository: () => void;
  actions: ActionSlice<"screen" | "section", "openSettings" | "leaveSettings">;
};

export function useSettingsScreen({
  sidebarOpen,
  sidebarToggleRef,
}: Pick<Layout, "sidebarOpen" | "sidebarToggleRef">): SettingsScreen {
  const [screen, setScreen] = useState<Screen>("repository");
  const [section, setSection] = useState<SettingsSection>("general");
  const settingsRef = useRef<HTMLButtonElement>(null);
  const leave = useCallback(() => {
    flushSync(() => setScreen("repository"));
    (sidebarOpen ? settingsRef : sidebarToggleRef).current?.focus();
  }, [sidebarOpen, sidebarToggleRef]);
  return {
    screen,
    section,
    setSection,
    settingsRef,
    leave,
    toRepository: () => setScreen("repository"),
    actions: defineSlice({
      context: { screen, section },
      commands: {
        openSettings: (next?: SettingsSection) => {
          if (next) setSection(next);
          setScreen("settings");
        },
        leaveSettings: leave,
      },
    }),
  };
}
