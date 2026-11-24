import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import type { Place, Screen, SettingsSection } from "../actions";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { Layout } from "./useLayout";

export type ScreenState = {
  screen: Screen;
  /** Where leaving Settings returns to. */
  place: Place;
  goTo: (place: Place) => void;
  section: SettingsSection;
  setSection: (section: SettingsSection) => void;
  settingsRef: RefObject<HTMLButtonElement | null>;
  /** Back to the place, focusing Settings, or the sidebar toggle while the sidebar is closed. */
  leave: () => void;
  /** Back to the repository screen without moving focus. */
  toRepository: () => void;
  actions: ActionSlice<
    "screen" | "place" | "section",
    "openSettings" | "leaveSettings"
  >;
};

export function useScreen({
  sidebarOpen,
  sidebarToggleRef,
}: Pick<Layout, "sidebarOpen" | "sidebarToggleRef">): ScreenState {
  const [place, goTo] = useState<Place>("repository");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("general");
  const settingsRef = useRef<HTMLButtonElement>(null);
  const screen: Screen = settingsOpen ? "settings" : place;
  const leave = useCallback(() => {
    flushSync(() => setSettingsOpen(false));
    (sidebarOpen ? settingsRef : sidebarToggleRef).current?.focus();
  }, [sidebarOpen, sidebarToggleRef]);
  return {
    screen,
    place,
    goTo,
    section,
    setSection,
    settingsRef,
    leave,
    toRepository: () => {
      setSettingsOpen(false);
      goTo("repository");
    },
    actions: defineSlice({
      context: { screen, place, section },
      commands: {
        openSettings: (next?: SettingsSection) => {
          if (next) setSection(next);
          setSettingsOpen(true);
        },
        leaveSettings: leave,
      },
    }),
  };
}
