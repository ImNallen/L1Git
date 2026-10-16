import { useEffect, useRef } from "react";
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

type Props = {
  files: readonly ChangedFile[];
  onSelectFile?: (path: string) => void;
};

export function ChangedFileTree({ files, onSelectFile }: Props) {
  const onSelectFileRef = useRef(onSelectFile);
  useEffect(() => {
    onSelectFileRef.current = onSelectFile;
  });
  const { model } = useFileTree({
    paths: files.map((file) => file.path),
    gitStatus: files.map((file) => ({
      path: file.path,
      status: changeStatuses[file.status].gitStatus,
    })),
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    density: "compact",
    onSelectionChange: ([path, ...rest]) => {
      if (
        path !== undefined &&
        rest.length === 0 &&
        files.some((file) => file.path === path)
      )
        onSelectFileRef.current?.(path);
    },
  });
  return <FileTree model={model} className="changed-file-tree" />;
}
