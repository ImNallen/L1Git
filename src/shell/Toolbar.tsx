import type { ReactNode, Ref } from "react";
import { actions as actionRegistry, titleOf } from "../actions";
import type { ActionId } from "../actions";
import type { ComposedActions } from "./actionSlices";
import { ContextMenu } from "../components/ContextMenu";
import type { RepositorySnapshot } from "../domain/repository";
import type { Layout, ToolbarMenuKind } from "./useLayout";
import type { WorkspaceView } from "./workspaceView";

const menus: { kind: ToolbarMenuKind; label: string; actions: ActionId[] }[] = [
  { kind: "fetch", label: "Fetch", actions: ["fetch"] },
  { kind: "pull", label: "Pull", actions: ["fastForward"] },
  { kind: "push", label: "Push", actions: ["push"] },
  {
    kind: "branch",
    label: "Branch",
    actions: [
      "newBranch",
      "checkout",
      "mergeBranch",
      "mergeUpstream",
      "createTag",
    ],
  },
  { kind: "stash", label: "Stash", actions: ["stashChanges"] },
  {
    kind: "more",
    label: "More",
    actions: [
      "undo",
      "redo",
      "fileHistory",
      "blame",
      "toggleSidebar",
      "openSettings",
    ],
  },
];

export function Toolbar({
  actions,
  searchSlot,
  sidebarToggle,
  inspectorToggle,
  layout,
  shown,
  snapshot,
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
}) {
  const { toolbarMenu: menu, setToolbarMenu: setMenu } = layout;
  const anchor = menu?.anchor.getBoundingClientRect();
  const close = (returnFocus: boolean) => {
    setMenu(null);
    if (returnFocus) menu?.anchor.focus();
  };
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
        {snapshot &&
          menus.map(({ kind, label }) => (
            <div className="toolbar-action-group" key={kind}>
              {kind === "branch" && <span className="toolbar-separator" />}
              <button
                className={`button toolbar-action ${kind}`}
                aria-haspopup="menu"
                aria-expanded={menu?.kind === kind}
                onClick={(event) =>
                  setMenu({ kind, anchor: event.currentTarget })
                }
              >
                <span
                  className={`workspace-action-icon ${kind}`}
                  aria-hidden="true"
                />
                <span>{label}</span>
                <span className="workspace-disclosure" aria-hidden="true" />
              </button>
            </div>
          ))}
        {!layout.inspectorVisible && inspectorToggle}
      </div>
      <div className="toolbar-search-slot" ref={searchSlot} />
      {menu && anchor && (
        <ContextMenu
          x={anchor.left}
          y={anchor.bottom}
          label={`${menus.find((each) => each.kind === menu.kind)?.label} actions`}
          onClose={({ returnFocus }) => close(returnFocus)}
        >
          {menus
            .find((each) => each.kind === menu.kind)
            ?.actions.map((id) =>
              actionRegistry.find((action) => action.id === id),
            )
            .map(
              (action) =>
                action && (
                  <button
                    key={action.id}
                    role="menuitem"
                    aria-disabled={!action.available(actions.context)}
                    onClick={() => {
                      if (!action.available(actions.context)) return;
                      close(true);
                      action.run(actions.commands);
                    }}
                  >
                    {titleOf(action, actions.context)}
                  </button>
                ),
            )}
        </ContextMenu>
      )}
    </header>
  );
}
