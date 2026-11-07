import { useEffect, useRef, useState } from "react";
import { WorkspaceIcon } from "./WorkspaceIcon";
import type { GitStatus } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import treeStyles from "../styles/changedFileTree.css?inline";
import focusStyles from "../styles/focus.css?inline";
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
  appliesTo?: ReadonlySet<string>;
};

export const focusedRow = '[data-type="item"][tabindex="0"]';

const focusIsFree = () =>
  document.activeElement === null || document.activeElement === document.body;

type Props = {
  files: readonly { path: string; status: GitStatus }[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  maxRows?: number;
  actions?: readonly RowAction[];
  refocusPath?: string | null;
  onFocused?: () => void;
  onRowFocus?: (row: string) => void;
};

const ITEM_HEIGHT = 32;

export function ChangedFileTree({
  files,
  selectedPath,
  onSelectFile,
  maxRows,
  actions = [],
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
    density: "default",
    itemHeight: ITEM_HEIGHT,
    icons: { set: "minimal", colored: false },
    renderRowDecoration: ({ item }) =>
      item.kind === "directory"
        ? { text: String(pathsUnder(files, item).length) }
        : null,
    fileTreeSearchMode: "hide-non-matches",
    searchBlurBehavior: "retain",
    unsafeCSS: `${focusStyles}
${treeStyles}`,
    composition:
      actions.length > 0
        ? {
            contextMenu: {
              triggerMode: "both",
              buttonVisibility: "when-needed",
            },
          }
        : undefined,
    onSelectionChange: ([shown, ...rest]) => {
      if (syncing.current) return;
      const path =
        shown === undefined ? undefined : changedPathAt(files, shown);
      if (path !== undefined && rest.length === 0)
        onSelectFileRef.current(path);
    },
  });
  const search = useFileTreeSearch(model);
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
        actions.length > 0
          ? (item, context) => (
              <ContextMenu
                x={context.anchorRect.left}
                y={context.anchorRect.bottom}
                label={`${item.name} actions`}
                onClose={({ returnFocus }) =>
                  context.close({ restoreFocus: returnFocus })
                }
              >
                {actions.map((action) => {
                  const paths = pathsUnder(files, item).filter(
                    (path) => action.appliesTo?.has(path) ?? true,
                  );
                  return (
                    paths.length > 0 && (
                      <button
                        key={action.label}
                        role="menuitem"
                        aria-disabled={action.disabled}
                        onClick={() => {
                          if (action.disabled) return;
                          context.close();
                          action.run(paths, item.path);
                        }}
                      >
                        {action.label}
                      </button>
                    )
                  );
                })}
              </ContextMenu>
            )
          : undefined
      }
    />
  );
  if (maxRows === undefined)
    return (
      <>
        <label className="changed-files-filter">
          <WorkspaceIcon name="Search" />
          <input
            aria-label="Filter changed files"
            placeholder="Filter changed files…"
            value={search.value}
            onChange={(event) => {
              search.setValue(event.target.value || null);
            }}
          />
        </label>
        {search.value && search.matchingPaths.length === 0 && (
          <p className="tree-hint">No changed files match.</p>
        )}
        {tree}
      </>
    );
  return (
    <div
      className="fitted-file-tree"
      style={{ height: Math.min(rows, maxRows) * ITEM_HEIGHT + 8 }}
    >
      {tree}
    </div>
  );
}
