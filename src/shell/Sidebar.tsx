import { Settings } from "lucide-react";
import type { ReactNode } from "react";
import type { Commands } from "../actions";
import { PaneDivider } from "../components/PaneDivider";
import { RepositoryTree } from "../components/RepositoryTree";
import type { UpdateRestart } from "../components/UpdateRestart";
import { UpdateAffordance } from "../components/UpdatesSettings";
import type { RecentRepository } from "../domain/recents";
import type { RepositoryRoot } from "../domain/repository";
import type { RootSync } from "../overview";
import type { Updates } from "../updates";
import type { RefsState } from "../useRepositoryRefs";
import type { Layout } from "./useLayout";
import type { SidebarNavigation } from "./useNavigation";
import type { SidebarRefActions } from "./useRefWrites";
import type { SettingsScreen } from "./useSettingsScreen";

export function Sidebar({
  layout,
  toggle,
  settings,
  commands,
  entries,
  expansion,
  refs,
  activePath,
  sync,
  navigation,
  refActions,
  updates,
  restart,
}: {
  layout: Layout;
  toggle: ReactNode;
  settings: Pick<SettingsScreen, "settingsRef">;
  commands: Pick<Commands, "openSettings">;
  entries: RecentRepository[];
  expansion: {
    expanded: ReadonlySet<RepositoryRoot>;
    setExpanded: (root: RepositoryRoot, expanded: boolean) => void;
  };
  refs: ReadonlyMap<RepositoryRoot, RefsState>;
  activePath: RepositoryRoot | null;
  sync: ReadonlyMap<RepositoryRoot, RootSync>;
  navigation: SidebarNavigation;
  refActions: SidebarRefActions;
  updates: Updates;
  restart: UpdateRestart;
}) {
  return (
    <>
      <aside
        hidden={!layout.sidebarOpen}
        className="sidebar"
        style={{ width: layout.sidebarWidth }}
        aria-label="Repository sidebar"
      >
        <div className="brand" data-tauri-drag-region>
          {layout.sidebarOpen && toggle}
          <span data-tauri-drag-region>
            L1{" "}
            <span className="muted" data-tauri-drag-region>
              Git
            </span>
          </span>
        </div>
        <div className="repository-navigation">
          <RepositoryTree
            entries={entries}
            expanded={expansion.expanded}
            onToggle={(root) =>
              expansion.setExpanded(root, !expansion.expanded.has(root))
            }
            refs={refs}
            activePath={activePath}
            sync={sync}
            navigation={navigation}
            refActions={refActions}
          />
        </div>
        <footer className="sidebar-bottom">
          <button
            ref={settings.settingsRef}
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => commands.openSettings()}
          >
            <Settings size={16} />
          </button>
          <UpdateAffordance updates={updates} restart={restart} />
        </footer>
      </aside>
      {layout.sidebarOpen && (
        <PaneDivider
          label="Resize repository sidebar"
          width={layout.sidebarWidth}
          min={210}
          max={400}
          direction={1}
          onResize={layout.setSidebarWidth}
        />
      )}
    </>
  );
}
