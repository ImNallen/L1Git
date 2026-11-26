import type { FullRef, Oid, RepositoryRoot } from "../domain/repository";
import { get, query, queryAll } from "./appHarness";
import type { Bridge, World } from "./fakeBridge";
import { addLinkedWorktree, PIN, pinStatus } from "./fixtures";

export const HEAD = "1".repeat(40) as Oid;
export const tried = (number: number, from = "pin") =>
  `/fixture/.worktrees/${from}-pr-${number}` as RepositoryRoot;

export const sent = (number: number) => ({
  pull: { github: { owner: "octo", repo: "pin" }, number },
  head: {
    reference: `refs/heads/branch-${number}`,
    oid: HEAD,
    from: { kind: "same", edits: true },
  },
});

const made = (byte: number) =>
  byte.toString(16).padStart(2, "0").repeat(20) as Oid;

function pushedOn(world: World, head: Oid, count: number, fetched: boolean) {
  if (count === 0) return head;
  const base = made(0xc0);
  for (let at = 0, oid = head; at < count; at += 1) {
    const parent = at === count - 1 ? base : made(0xb0 + at);
    world.pullCommits.set(oid, { parent, fetched });
    oid = parent;
  }
  return base;
}

function committedOn(world: World, base: Oid, count: number) {
  let tip = base;
  for (let at = 0; at < count; at += 1) {
    const oid = made(0xa0 + at);
    world.pullCommits.set(oid, { parent: tip, fetched: true });
    tip = oid;
  }
  return tip;
}

export function holding(
  world: World,
  number: number,
  {
    ahead = 0,
    behind = 0,
    fetched = true,
    worktree = "clean",
  }: {
    ahead?: number;
    behind?: number;
    fetched?: boolean;
    worktree?: "clean" | "uncommitted" | "missing" | "main" | null;
  },
  { root = PIN, head = HEAD }: { root?: RepositoryRoot; head?: Oid } = {},
) {
  const base = pushedOn(world, head, behind, fetched);
  const tip = committedOn(world, base, ahead);
  const name = `pr/${number}`;
  const snapshot = world.snapshots.get(root)!;
  world.snapshots.set(root, {
    ...snapshot,
    branches: [
      ...snapshot.branches,
      {
        kind: "local",
        reference: `refs/heads/${name}` as FullRef,
        name,
        oid: tip,
        upstream: null,
      },
    ],
  });
  const folder = worktree === "main" ? root : tried(number, snapshot.name);
  if (worktree === "clean" || worktree === "uncommitted")
    addLinkedWorktree(world, root, folder, name);
  if (worktree === "uncommitted")
    world.statuses.set(folder, {
      ...world.statuses.get(folder)!,
      entries: pinStatus().entries,
    });
  world.pullCopies.set(`${root} #${number}`, {
    tip,
    worktree:
      worktree === null ? null : { root: folder, main: worktree === "main" },
  });
  return tip;
}

export const short = (oid: string) => oid.slice(0, 7);

export const checkoutWrites = (bridge: Bridge) =>
  bridge.log.filter((request) =>
    ["tryPullRequest", "updatePullRequest", "removePullRequest"].includes(
      request.op,
    ),
  );

export const bar = () => query("group", "Local copy");
export const barText = () =>
  bar()?.querySelector("[role='status']")?.textContent ?? null;
export const barButtons = () =>
  queryAll("button")
    .filter((button) => bar()?.contains(button))
    .map((button) => button.textContent);
export const tryButton = () => query("button", "Try it locally");
export const popover = () => get("dialog", /^Try #\d+ locally$/);
