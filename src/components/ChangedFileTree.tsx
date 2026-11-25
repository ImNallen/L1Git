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
import { counted } from "../domain/pullRequestDetail";
import { useTreeMotion } from "./useTreeMotion";
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
  blockedBy?: ReadonlyMap<string, string>;
};

export type RowLabel = { text: string; tone: "warning" | "success" };

const labelColors: Record<RowLabel["tone"], string> = {
  warning: "var(--warning)",
  success: "var(--success)",
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
  labels?: ReadonlyMap<string, RowLabel>;
  /** How many comments a file has. */
  comments?: ReadonlyMap<string, number>;
};

const ROW_HEIGHT = 34;

type RowItem = { action: RowAction; paths: string[]; blocked: string | null };

export function rowItems(
  actions: readonly RowAction[],
  under: readonly string[],
): RowItem[] {
  return actions.flatMap((action): RowItem[] => {
    const paths = under.filter((path) => action.appliesTo?.has(path) ?? true);
    if (paths.length > 0) return [{ action, paths, blocked: null }];
    const blocked = under
      .map((path) => action.blockedBy?.get(path))
      .find((reason) => reason !== undefined);
    return blocked === undefined ? [] : [{ action, paths, blocked }];
  });
}

function fittedTreeHeight(
  model: ReturnType<typeof useFileTree>["model"],
  maxRows: number | undefined,
) {
  if (maxRows === undefined) return 0;
  return Math.min(model.getVisibleCount(), maxRows) * ROW_HEIGHT + 8;
}

export function ChangedFileTree({
  files,
  selectedPath,
  onSelectFile,
  maxRows,
  actions = [],
  refocusPath = null,
  onFocused,
  onRowFocus,
  labels,
  comments,
}: Props) {
  const commentsNow = useRef(comments);
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
    gitStatus: files
      .filter((file) => !labels?.has(file.path))
      .map((file) => ({
        path: treePath(file.path),
        status: file.status,
      })),
    initialExpansion,
    flattenEmptyDirectories,
    density: "default",
    itemHeight: ROW_HEIGHT,
    icons: { set: "minimal", colored: false },
    renderRowDecoration: ({ item }) => {
      if (item.kind === "directory")
        return { text: String(pathsUnder(files, item).length) };
      const path = changedPathAt(files, item.path);
      const label = path === undefined ? undefined : labels?.get(path);
      const count =
        (path === undefined ? undefined : commentsNow.current?.get(path)) ?? 0;
      const parts = [
        ...(count > 0
          ? [{ text: count.toLocaleString(), color: "var(--blue)" }]
          : []),
        ...(label
          ? [{ text: label.text, color: labelColors[label.tone] }]
          : []),
      ];
      return parts.length > 0
        ? {
            text: parts.map(({ text }) => text).join(" "),
            title: count > 0 ? counted(count, "comment") : undefined,
            parts,
          }
        : null;
    },
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
  const prepareMotion = useTreeMotion();
  const search = useFileTreeSearch(model);
  useEffect(() => {
    const shown = selectedPath === null ? null : treePath(selectedPath);
    syncing.current = true;
    for (const path of model.getSelectedPaths())
      if (path !== shown) model.getItem(path)?.deselect();
    if (shown !== null && !model.getItem(shown)?.isSelected()) {
      model.getItem(shown)?.select();
      model.scrollToPath(shown, { focus: false, offset: "nearest" });
    }
    syncing.current = false;
  }, [model, selectedPath]);
  useEffect(() => {
    if (commentsNow.current === comments) return;
    commentsNow.current = comments;
    // Draws the rows again, where they are.
    model.setLabels();
  }, [model, comments]);
  const [height, setHeight] = useState(() => fittedTreeHeight(model, maxRows));
  useEffect(() => {
    if (maxRows === undefined) return;
    const resize = () => setHeight(fittedTreeHeight(model, maxRows));
    resize();
    return model.subscribe(resize);
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
      onClickCapture={prepareMotion}
      onKeyDownCapture={prepareMotion}
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
                {rowItems(actions, pathsUnder(files, item)).map(
                  ({ action, paths, blocked }) => (
                    <button
                      key={action.label}
                      role="menuitem"
                      aria-disabled={action.disabled || blocked !== null}
                      title={blocked ?? undefined}
                      onClick={() => {
                        if (action.disabled || blocked !== null) return;
                        context.close();
                        action.run(paths, item.path);
                      }}
                    >
                      <span>{action.label}</span>
                      {blocked !== null && (
                        <small className="menu-reason">{blocked}</small>
                      )}
                    </button>
                  ),
                )}
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
    <div className="fitted-file-tree" style={{ height }}>
      {tree}
    </div>
  );
}
