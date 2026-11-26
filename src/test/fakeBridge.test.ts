import { describe, expect, it } from "vitest";
import { createBridge } from "./fakeBridge";
import { PIN, staged } from "./fixtures";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const pull = { github: { owner: "octo", repo: "pin" }, number: 7 };
const head = (oid: string) => ({
  reference: "refs/heads/feat",
  oid,
  from: { kind: "same" },
});

function bridge() {
  const bridge = createBridge();
  const run = async (op: string, fields: Record<string, unknown>) =>
    (await (
      await bridge.fetch("/api/run", {
        method: "POST",
        body: JSON.stringify({ op, path: PIN, pull, ...fields }),
      })
    ).json()) as {
      ok: boolean;
      data: {
        kind: string;
        tip: string;
        relation: { kind: string };
        worktree: { root: string };
      };
      error: { kind: string; reason?: string };
    };
  const tried = async () =>
    (await run("tryPullRequest", { head: head(A), folder: "/fixture/pr-7" }))
      .data;
  return { world: bridge.world, run, tried };
}

describe("the fake bridge's pull request copies, as the core keeps them", () => {
  it("answers the copy from any worktree of the repository, its own too", async () => {
    const { run, tried } = bridge();
    const { worktree } = await tried();
    const read = await run("pullCheckout", {
      path: worktree.root,
      head: head(A),
    });
    expect(read.data).toMatchObject({ kind: "ready", worktree });
  });

  it("compares the copy with the head on each read, and Update fetches what the author pushed", async () => {
    const { world, run, tried } = bridge();
    await tried();
    const relation = async (oid: string) =>
      (await run("pullCheckout", { head: head(oid) })).data.relation.kind;
    expect(await relation(A)).toBe("upToDate");
    expect(await relation(B)).toBe("unfetched");

    const refused = await run("updatePullRequest", {
      head: head(B),
      seen: A,
      replace: false,
    });
    expect(refused.error).toMatchObject({
      kind: "staleView",
      reason: "branchChanged",
    });

    world.pullCommits.set(B, { parent: A, fetched: false });
    expect(await relation(B)).toBe("unfetched");
    const updated = await run("updatePullRequest", {
      head: head(B),
      seen: A,
      replace: false,
    });
    expect(updated.data).toMatchObject({
      tip: B,
      relation: { kind: "upToDate" },
    });

    world.pullCommits.set(C, { parent: A, fetched: true });
    expect(await relation(C)).toBe("diverged");
  });

  it("refuses to remove a copy with uncommitted files, an operation in progress, or in the main worktree", async () => {
    const { world, run, tried } = bridge();
    const { worktree } = await tried();
    const root = worktree.root as typeof PIN;
    const remove = () => run("removePullRequest", { head: head(A), seen: A });
    const status = world.statuses.get(root)!;
    world.statuses.set(root, { ...status, entries: [staged("notes.txt")] });
    expect((await remove()).error).toMatchObject({ kind: "conflict" });
    world.statuses.set(root, status);

    const [key, copy] = [...world.pullCopies][0]!;
    const busy = { ...copy.worktree!, operation: "rebase" as const };
    world.pullCopies.set(key, { ...copy, worktree: busy });
    expect((await remove()).error).toMatchObject({ kind: "conflict" });
    world.pullCopies.set(key, { ...copy, worktree: { root: PIN, main: true } });
    expect((await remove()).error).toMatchObject({ kind: "unsupportedPath" });
    world.pullCopies.set(key, copy);

    expect((await remove()).data.kind).toBe("absent");
    expect(world.snapshots.has(root)).toBe(false);
    expect(
      world.snapshots.get(PIN)!.branches.some(({ name }) => name === "pr/7"),
    ).toBe(false);
  });
});
