import type { Branch } from "./repository";

export type BranchTree = { folders: BranchFolder[]; branches: Branch[] };
export type BranchFolder = BranchTree & {
  path: string;
  name: string;
  count: number;
};

type Entry = { branch: Branch; folders: string[] };

export function branchTree(branches: readonly Branch[]): BranchTree {
  return grow(
    branches.map((branch) => ({
      branch,
      folders: branch.name.split("/").slice(0, -1),
    })),
    "",
  );
}

function grow(entries: Entry[], prefix: string): BranchTree {
  const groups = new Map<string, Entry[]>();
  const branches: Branch[] = [];
  for (const { branch, folders: path } of entries) {
    const [folder, ...rest] = path;
    if (folder === undefined) branches.push(branch);
    else
      groups.set(folder, [
        ...(groups.get(folder) ?? []),
        { branch, folders: rest },
      ]);
  }
  const folders = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, children]) => {
      const path = prefix + name;
      return {
        path,
        name,
        count: children.length,
        ...grow(children, `${path}/`),
      };
    });
  return { folders, branches };
}
