import { describe, expect, it } from "vitest";
import { refLabels } from "./refs";
import { oidSchema, snapshotSchema } from "./repository";

const a = oidSchema.parse("a".repeat(40));
const b = oidSchema.parse("b".repeat(40));
const c = oidSchema.parse("c".repeat(40));

function snapshot(head: Record<string, unknown>) {
  return snapshotSchema.parse({
    root: "/code/app",
    name: "app",
    head,
    branches: [
      {
        kind: "local",
        reference: "refs/heads/feature",
        name: "feature",
        oid: a,
        upstream: null,
      },
      {
        kind: "local",
        reference: "refs/heads/main",
        name: "main",
        oid: a,
        upstream: "refs/remotes/origin/main",
      },
      {
        kind: "local",
        reference: "refs/heads/review",
        name: "review",
        oid: b,
        upstream: null,
      },
      {
        kind: "remote",
        reference: "refs/remotes/origin/main",
        name: "origin/main",
        oid: a,
        remote: "origin",
      },
    ],
    tags: [
      { reference: "refs/tags/v1.0", name: "v1.0", oid: a },
      { reference: "refs/tags/v0.9", name: "v0.9", oid: c },
    ],
    worktrees: [
      {
        root: "/code/app",
        name: "app",
        head,
        current: true,
      },
      {
        root: "/code/app-review",
        name: "app-review",
        head: { kind: "attached", reference: "refs/heads/review", oid: b },
        current: false,
      },
      {
        root: "/code/app-bisect",
        name: "app-bisect",
        head: { kind: "detached", oid: a },
        current: false,
      },
      {
        root: "/code/app-new",
        name: "app-new",
        head: { kind: "unborn", reference: "refs/heads/new" },
        current: false,
      },
    ],
    remotes: [],
    commits: [],
    squashes: [],
    historyTruncated: false,
    observedAt: 0,
  });
}

describe("ref labels", () => {
  it("orders the checked-out branch, other branches, worktrees, remotes, then tags", () => {
    expect(
      refLabels(
        snapshot({ kind: "attached", reference: "refs/heads/main", oid: a }),
      ),
    ).toEqual(
      new Map([
        [
          a,
          [
            {
              kind: "local",
              name: "main",
              reference: "refs/heads/main",
              head: true,
              worktree: null,
            },
            {
              kind: "local",
              name: "feature",
              reference: "refs/heads/feature",
              head: false,
              worktree: null,
            },
            { kind: "worktree", name: "app-bisect", root: "/code/app-bisect" },
            {
              kind: "remote",
              name: "origin/main",
              reference: "refs/remotes/origin/main",
            },
            { kind: "tag", name: "v1.0", reference: "refs/tags/v1.0" },
          ],
        ],
        [
          b,
          [
            {
              kind: "local",
              name: "review",
              reference: "refs/heads/review",
              head: false,
              worktree: "app-review",
            },
          ],
        ],
        [c, [{ kind: "tag", name: "v0.9", reference: "refs/tags/v0.9" }]],
      ]),
    );
  });

  it("labels a detached HEAD of the opened root first and marks no branch as head", () => {
    const labels = refLabels(snapshot({ kind: "detached", oid: c }));
    expect(labels.get(c)).toEqual([
      { kind: "head" },
      { kind: "tag", name: "v0.9", reference: "refs/tags/v0.9" },
    ]);
    expect(labels.get(a)?.slice(0, 2)).toEqual([
      {
        kind: "local",
        name: "feature",
        reference: "refs/heads/feature",
        head: false,
        worktree: null,
      },
      {
        kind: "local",
        name: "main",
        reference: "refs/heads/main",
        head: false,
        worktree: null,
      },
    ]);
  });
});
