import { prepareFileTreeInput } from "@pierre/trees";
import type { ChangedFile } from "./repository";

export const flattenEmptyDirectories = true;
export const initialExpansion = "open";

export function changedFileTreeInput(files: readonly ChangedFile[]) {
  return prepareFileTreeInput(
    files.map((file) => file.path),
    { flattenEmptyDirectories },
  );
}

export function firstChangedPath(
  files: readonly ChangedFile[],
): string | undefined {
  return changedFileTreeInput(files).paths.at(0);
}
