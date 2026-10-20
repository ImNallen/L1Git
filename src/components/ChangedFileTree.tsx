import { useEffect, useRef } from "react";
import { prepareFileTreeInput } from "@pierre/trees";
import type { GitStatus } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { ChangeStatus, ChangedFile } from "../domain/repository";

export const changeStatuses = {
  A: { label: "added", gitStatus: "added" },
  D: { label: "deleted", gitStatus: "deleted" },
  M: { label: "modified", gitStatus: "modified" },
  T: { label: "type changed", gitStatus: "modified" },
} as const satisfies Record<
  ChangeStatus,
  { label: string; gitStatus: GitStatus }
>;

const flattenEmptyDirectories = true;

function treeInput(files: readonly ChangedFile[]) {
  return prepareFileTreeInput(
    files.map((file) => file.path),
    { flattenEmptyDirectories },
  );
}

export function firstChangedPath(
  files: readonly ChangedFile[],
): string | undefined {
  return treeInput(files).paths.at(0);
}

type Props = {
  files: readonly ChangedFile[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
};

export function ChangedFileTree({ files, selectedPath, onSelectFile }: Props) {
  const onSelectFileRef = useRef(onSelectFile);
  useEffect(() => {
    onSelectFileRef.current = onSelectFile;
  });
  const { model } = useFileTree({
    preparedInput: treeInput(files),
    gitStatus: files.map((file) => ({
      path: file.path,
      status: changeStatuses[file.status].gitStatus,
    })),
    initialExpansion: "open",
    flattenEmptyDirectories,
    density: "compact",
    onSelectionChange: ([path, ...rest]) => {
      if (
        path !== undefined &&
        rest.length === 0 &&
        files.some((file) => file.path === path)
      )
        onSelectFileRef.current(path);
    },
  });
  useEffect(() => {
    if (selectedPath === null)
      for (const path of model.getSelectedPaths())
        model.getItem(path)?.deselect();
  }, [model, selectedPath]);
  return <FileTree model={model} className="changed-file-tree" />;
}
