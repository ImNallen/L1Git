import { useEffect, useRef, useState } from "react";
import { FILE_TREE_DENSITY_PRESETS } from "@pierre/trees";
import type { GitStatus } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  changedFileTreeInput,
  changedPathAt,
  flattenEmptyDirectories,
  initialExpansion,
  treePath,
} from "../domain/changedFiles";
import type { ChangeStatus } from "../domain/repository";

export const changeStatuses = {
  A: { label: "added", gitStatus: "added" },
  D: { label: "deleted", gitStatus: "deleted" },
  M: { label: "modified", gitStatus: "modified" },
  T: { label: "type changed", gitStatus: "modified" },
} as const satisfies Record<
  ChangeStatus,
  { label: string; gitStatus: GitStatus }
>;

type Props = {
  files: readonly { path: string; status: GitStatus }[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  maxRows?: number;
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
}: Props) {
  const onSelectFileRef = useRef(onSelectFile);
  useEffect(() => {
    onSelectFileRef.current = onSelectFile;
  });
  const [preparedInput] = useState(() => changedFileTreeInput(files));
  const { model } = useFileTree({
    preparedInput,
    gitStatus: files.map((file) => ({
      path: treePath(file.path),
      status: file.status,
    })),
    initialExpansion,
    flattenEmptyDirectories,
    density: "compact",
    unsafeCSS: keyboardFocusOnly,
    onSelectionChange: ([shown, ...rest]) => {
      const path =
        shown === undefined ? undefined : changedPathAt(files, shown);
      if (path !== undefined && rest.length === 0)
        onSelectFileRef.current(path);
    },
  });
  useEffect(() => {
    if (selectedPath === null)
      for (const path of model.getSelectedPaths())
        model.getItem(path)?.deselect();
  }, [model, selectedPath]);
  const [rows, setRows] = useState(() => model.getVisibleCount());
  useEffect(() => {
    if (maxRows === undefined) return;
    const count = () => setRows(model.getVisibleCount());
    count();
    return model.subscribe(count);
  }, [model, maxRows]);
  const tree = <FileTree model={model} className="changed-file-tree" />;
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
