import { prepareFileTreeInput } from "@pierre/trees";

export const flattenEmptyDirectories = true;
export const initialExpansion = "open";

/** Git lists an untracked nested repository as `nested/`, which a tree reads as a folder. */
export function treePath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function changedFileTreeInput(files: readonly { path: string }[]) {
  return prepareFileTreeInput(
    files.map((file) => treePath(file.path)),
    { flattenEmptyDirectories },
  );
}

export function changedPathAt(
  files: readonly { path: string }[],
  shown: string,
): string | undefined {
  return files.find((file) => treePath(file.path) === shown)?.path;
}

export function firstChangedPath(
  files: readonly { path: string }[],
): string | undefined {
  const first = changedFileTreeInput(files).paths.at(0);
  return first === undefined ? undefined : changedPathAt(files, first);
}
