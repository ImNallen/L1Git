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

export function listsRow(
  files: readonly { path: string }[],
  row: string,
): boolean {
  const kind = row.endsWith("/") ? "directory" : "file";
  return pathsUnder(files, { kind, path: row }).length > 0;
}

export function rowsAfterThenBefore(
  files: readonly { path: string }[],
  row: string,
): string[] {
  const kind = row.endsWith("/") ? "directory" : "file";
  const gone = new Set(pathsUnder(files, { kind, path: row }).map(treePath));
  const rows = changedFileTreeInput(files).paths;
  const at = rows.findIndex((path) => gone.has(path));
  if (at === -1) return [];
  return [
    ...rows.slice(at).filter((path) => !gone.has(path)),
    ...rows.slice(0, at).reverse(),
  ];
}

export function pathsUnder(
  files: readonly { path: string }[],
  item: { kind: "file" | "directory"; path: string },
): string[] {
  const shown = treePath(item.path);
  if (item.kind === "file") {
    const path = changedPathAt(files, shown);
    return path === undefined ? [] : [path];
  }
  return files
    .filter((file) => treePath(file.path).startsWith(`${shown}/`))
    .map((file) => file.path);
}
