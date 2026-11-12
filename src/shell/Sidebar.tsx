import { WorkspaceIcon } from "../components/WorkspaceIcon";
import type { Commands } from "../actions";
import { PaneDivider } from "../components/PaneDivider";
import { RepositoryTree } from "../components/RepositoryTree";
import type { UpdateRestart } from "../components/UpdateRestart";
import { UpdateAffordance } from "../components/UpdatesSettings";
import type { OperationProbe } from "../domain/merge";
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
  settings,
  commands,
  entries,
  expansion,
  refs,
  activePath,
  sync,
  operations,
  navigation,
  refActions,
  updates,
  restart,
}: {
  layout: Layout;
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
  operations: ReadonlyMap<RepositoryRoot, OperationProbe>;
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
        <div className="brand" data-tauri-drag-region />
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
            operations={operations}
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
            <WorkspaceIcon name="Settings" size={18} />
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
