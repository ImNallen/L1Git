import type { Ref } from "react";
import { actions as actionRegistry, titleOf } from "../actions";
import type { ActionId } from "../actions";
import type { ComposedActions } from "./actionSlices";
import { ContextMenu } from "../components/ContextMenu";
import type { RepositorySnapshot } from "../domain/repository";
import type { Layout, ToolbarMenuKind } from "./useLayout";
import type { WorkspaceView } from "./workspaceView";

const menus: { kind: ToolbarMenuKind; label: string; actions: ActionId[] }[] = [
  { kind: "fetch", label: "Fetch", actions: ["fetch", "fetchAll"] },
  {
    kind: "pull",
    label: "Pull",
    actions: ["pullFastForwardIfPossible", "pullFastForwardOnly", "pullRebase"],
  },
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
  layout,
  shown,
  snapshot,
}: {
  actions: ComposedActions;
  searchSlot: Ref<HTMLDivElement>;
  layout: Pick<Layout, "toolbarMenu" | "setToolbarMenu">;
  shown: WorkspaceView["shown"];
  snapshot: RepositorySnapshot | null;
}) {
  const { toolbarMenu: menu, setToolbarMenu: setMenu } = layout;
  const anchor = menu?.anchor.getBoundingClientRect();
  const opened = menus.find((each) => each.kind === menu?.kind);
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
      </div>
      <div className="toolbar-search-slot" ref={searchSlot} />
      {menu && anchor && (
        <ContextMenu
          closeOnPointerLeave
          className="toolbar-menu"
          x={anchor.left}
          y={anchor.bottom + 6}
          label={`${opened?.label} actions`}
          onClose={({ returnFocus }) => close(returnFocus)}
        >
          {opened?.actions
            .map((id) => actionRegistry.find((action) => action.id === id))
            .map((action) => {
              if (!action) return null;
              const available = action.available(actions.context);
              const title = titleOf(action, actions.context);
              return (
                <button
                  key={action.id}
                  role="menuitem"
                  title={action.detail?.(actions.context) ?? title}
                  aria-disabled={!available}
                  onClick={() => {
                    if (!available) return;
                    close(true);
                    action.run(actions.commands);
                  }}
                >
                  <span className="toolbar-menu-label">{title}</span>
                </button>
              );
            })}
        </ContextMenu>
      )}
    </header>
  );
}
