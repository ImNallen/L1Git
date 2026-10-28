import { useEffect, useRef, useState } from "react";
import { FILE_TREE_DENSITY_PRESETS } from "@pierre/trees";
import type { GitStatus } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  changedFileTreeInput,
  changedPathAt,
  flattenEmptyDirectories,
  initialExpansion,
  pathsUnder,
  treePath,
} from "../domain/changedFiles";
import type { ChangeStatus } from "../domain/repository";
import { ContextMenu } from "./ContextMenu";

export const changeStatuses = {
  A: { label: "added", gitStatus: "added" },
  D: { label: "deleted", gitStatus: "deleted" },
  M: { label: "modified", gitStatus: "modified" },
  T: { label: "type changed", gitStatus: "modified" },
} as const satisfies Record<
  ChangeStatus,
  { label: string; gitStatus: GitStatus }
>;

export type RowAction = {
  label: string;
  disabled: boolean;
  run: (paths: string[], row: string) => void;
};

export const focusedRow = '[data-type="item"][tabindex="0"]';

const focusIsFree = () =>
  document.activeElement === null || document.activeElement === document.body;

type Props = {
  files: readonly { path: string; status: GitStatus }[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  maxRows?: number;
  action?: RowAction;
  refocusPath?: string | null;
  onFocused?: () => void;
  onRowFocus?: (row: string) => void;
};

const ITEM_HEIGHT = FILE_TREE_DENSITY_PRESETS.compact.itemHeight;

export const keyboardFocusOnly = `
  [data-type="item"]:focus-visible {
    background-color: color-mix(in srgb, var(--primary-bg) 10%, var(--canvas));
    box-shadow: inset 2px 0 0 var(--blue);
  }
  [data-type="item"][data-item-selected="true"]:focus-visible {
    background-color: color-mix(in srgb, var(--primary-bg) 10%, var(--nav-selected-bg));
  }
`;

export function ChangedFileTree({
  files,
  selectedPath,
  onSelectFile,
  maxRows,
  action,
  refocusPath = null,
  onFocused,
  onRowFocus,
}: Props) {
  const onSelectFileRef = useRef(onSelectFile);
  useEffect(() => {
    onSelectFileRef.current = onSelectFile;
  });
  const syncing = useRef(false);
  const [preparedInput] = useState(() => changedFileTreeInput(files));
  const [initialSelectedPaths] = useState(() =>
    selectedPath !== null && files.some((file) => file.path === selectedPath)
      ? [treePath(selectedPath)]
      : [],
  );
  const { model } = useFileTree({
    preparedInput,
    initialSelectedPaths,
    gitStatus: files.map((file) => ({
      path: treePath(file.path),
      status: file.status,
    })),
    initialExpansion,
    flattenEmptyDirectories,
    density: "compact",
    unsafeCSS: keyboardFocusOnly,
    composition: action && {
      contextMenu: { triggerMode: "both", buttonVisibility: "when-needed" },
    },
    onSelectionChange: ([shown, ...rest]) => {
      if (syncing.current) return;
      const path =
        shown === undefined ? undefined : changedPathAt(files, shown);
      if (path !== undefined && rest.length === 0)
        onSelectFileRef.current(path);
    },
  });
  useEffect(() => {
    const shown = selectedPath === null ? null : treePath(selectedPath);
    syncing.current = true;
    for (const path of model.getSelectedPaths())
      if (path !== shown) model.getItem(path)?.deselect();
    if (shown !== null && !model.getItem(shown)?.isSelected())
      model.getItem(shown)?.select();
    syncing.current = false;
  }, [model, selectedPath]);
  const [rows, setRows] = useState(() => model.getVisibleCount());
  useEffect(() => {
    if (maxRows === undefined) return;
    const count = () => setRows(model.getVisibleCount());
    count();
    return model.subscribe(count);
  }, [model, maxRows]);
  useEffect(() => {
    if (refocusPath === null) return;
    if (!focusIsFree()) {
      onFocused?.();
      return;
    }
    model.focusPath(refocusPath);
    const frame = requestAnimationFrame(() => {
      if (focusIsFree())
        model
          .getFileTreeContainer()
          ?.shadowRoot?.querySelector<HTMLElement>(focusedRow)
          ?.focus();
      onFocused?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [model, refocusPath, onFocused]);
  const tree = (
    <FileTree
      model={model}
      className="changed-file-tree"
      onFocus={(event) => {
        const [row] = event.nativeEvent.composedPath();
        if (row instanceof HTMLElement && row.dataset.itemPath)
          onRowFocus?.(row.dataset.itemPath);
      }}
      renderContextMenu={
        action &&
        ((item, context) => (
          <ContextMenu
            x={context.anchorRect.left}
            y={context.anchorRect.bottom}
            label={`${item.name} actions`}
            onClose={({ returnFocus }) =>
              context.close({ restoreFocus: returnFocus })
            }
          >
            <button
              role="menuitem"
              aria-disabled={action.disabled}
              onClick={() => {
                if (action.disabled) return;
                context.close();
                action.run(pathsUnder(files, item), item.path);
              }}
            >
              {action.label}
            </button>
          </ContextMenu>
        ))
      }
    />
  );
  if (maxRows === undefined) return tree;
  return (
    <div
      className="fitted-file-tree"
      style={{ height: Math.min(rows, maxRows) * ITEM_HEIGHT + 8 }}
    >
      {tree}
    </div>
  );
}
