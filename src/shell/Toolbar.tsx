import type { ReactNode, Ref } from "react";
import { actions as actionRegistry, titleOf } from "../actions";
import type { ComposedActions } from "./actionSlices";
import { ContextMenu } from "../components/ContextMenu";
import { REDO_SHORTCUT, shortcutLabel, UNDO_SHORTCUT } from "../actions";
import { UndoButtons } from "../components/UndoControls";
import type { RepositorySnapshot } from "../domain/repository";
import { mac } from "../repositories";
import type { WritesView } from "../useWrites";
import type { SyncCommands, SyncControls } from "./sync";
import { SyncButtons } from "./SyncRegions";
import type { Layout } from "./useLayout";
import type { WorkspaceView } from "./workspaceView";

export function Toolbar({
  actions,
  searchSlot,
  sidebarToggle,
  inspectorToggle,
  layout,
  shown,
  snapshot,
  writes,
  sync,
  commands,
}: {
  actions: ComposedActions;
  searchSlot: Ref<HTMLDivElement>;
  sidebarToggle: ReactNode;
  inspectorToggle: ReactNode;
  layout: Pick<
    Layout,
    "sidebarOpen" | "inspectorVisible" | "toolbarMenu" | "setToolbarMenu"
  >;
  shown: WorkspaceView["shown"];
  snapshot: RepositorySnapshot | null;
  writes: WritesView;
  sync: SyncControls;
  commands: SyncCommands;
}) {
  const { toolbarMenu: menu, setToolbarMenu: setMenu } = layout;
  const branch = actionRegistry.find((action) => action.id === "newBranch");
  const stash = actionRegistry.find((action) => action.id === "stashChanges");
  return (
    <header
      aria-label={
        shown ? `${shown.name} repository actions` : "Workspace actions"
      }
      className="toolbar"
      data-tauri-drag-region
    >
      {!layout.sidebarOpen && sidebarToggle}
      <div className="toolbar-actions">
        <SyncButtons sync={sync} commands={commands} />
        {snapshot && (
          <>
            <span className="toolbar-separator" />
            <button
              className="button"
              disabled={!branch?.available(actions.context)}
              onClick={actions.commands.newBranch}
              title={branch ? titleOf(branch, actions.context) : undefined}
            >
              <span
                className="workspace-action-icon branch"
                aria-hidden="true"
              />
              <span>Branch</span>
            </button>
            <button
              className="button"
              disabled={!stash?.available(actions.context)}
              onClick={actions.commands.stashChanges}
            >
              <span
                className="workspace-action-icon stash"
                aria-hidden="true"
              />
              <span>Stash</span>
            </button>
            <button
              className="button"
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              onClick={(event) =>
                setMenu(event.currentTarget.getBoundingClientRect())
              }
            >
              <span className="workspace-action-icon more" aria-hidden="true" />
              <span>More</span>
            </button>
          </>
        )}
        {snapshot && (
          <UndoButtons
            writes={writes}
            shortcuts={{
              undo: shortcutLabel(UNDO_SHORTCUT, mac),
              redo: shortcutLabel(REDO_SHORTCUT, mac),
            }}
          />
        )}
        {!layout.inspectorVisible && inspectorToggle}
      </div>
      <div className="toolbar-search-slot" ref={searchSlot} />
      {menu && (
        <ContextMenu
          x={menu.left}
          y={menu.bottom}
          label="Repository actions"
          onClose={() => setMenu(null)}
        >
          {actionRegistry
            .filter((action) =>
              [
                "mergeUpstream",
                "mergeBranch",
                "createTag",
                "checkout",
                "openSettings",
              ].includes(action.id),
            )
            .map((action) => (
              <button
                key={action.id}
                role="menuitem"
                disabled={!action.available(actions.context)}
                onClick={() => {
                  setMenu(null);
                  action.run(actions.commands);
                }}
              >
                {titleOf(action, actions.context)}
              </button>
            ))}
        </ContextMenu>
      )}
    </header>
  );
}
