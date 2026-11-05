import type { ReactNode } from "react";
import { REDO_SHORTCUT, shortcutLabel, UNDO_SHORTCUT } from "../actions";
import { UndoButtons } from "../components/UndoControls";
import { headBranchName } from "../domain/refs";
import type { RepositorySnapshot } from "../domain/repository";
import { mac } from "../repositories";
import type { WritesView } from "../useWrites";
import type { SyncCommands, SyncControls } from "./sync";
import { SyncButtons } from "./SyncRegions";
import type { Layout } from "./useLayout";
import type { WorkspaceView } from "./workspaceView";

export function Toolbar({
  sidebarToggle,
  inspectorToggle,
  layout,
  shown,
  snapshot,
  writes,
  sync,
  commands,
}: {
  sidebarToggle: ReactNode;
  inspectorToggle: ReactNode;
  layout: Pick<Layout, "sidebarOpen" | "inspectorVisible">;
  shown: WorkspaceView["shown"];
  snapshot: RepositorySnapshot | null;
  writes: WritesView;
  sync: SyncControls;
  commands: SyncCommands;
}) {
  const headLabel =
    snapshot &&
    (snapshot.head.kind === "detached"
      ? `Detached at ${snapshot.head.oid.slice(0, 7)}`
      : headBranchName(snapshot.head, snapshot.branches));
  return (
    <header className="toolbar" data-tauri-drag-region>
      {!layout.sidebarOpen && sidebarToggle}
      <div className="breadcrumb" data-tauri-drag-region>
        {shown ? (
          <span className="repository-name" title={shown.root}>
            {shown.name}
          </span>
        ) : (
          <span className="muted">Workspace</span>
        )}
        {headLabel && (
          <>
            <span className="breadcrumb-slash" aria-hidden="true">
              /
            </span>
            <span className="breadcrumb-branch" title={headLabel}>
              {headLabel}
            </span>
          </>
        )}
      </div>
      <div className="toolbar-actions">
        {snapshot && (
          <UndoButtons
            writes={writes}
            shortcuts={{
              undo: shortcutLabel(UNDO_SHORTCUT, mac),
              redo: shortcutLabel(REDO_SHORTCUT, mac),
            }}
          />
        )}
        <SyncButtons sync={sync} commands={commands} />
        {!layout.inspectorVisible && inspectorToggle}
      </div>
    </header>
  );
}
