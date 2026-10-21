import { describe, expect, it } from "vitest";
import { oidSchema, refSchema, rootSchema } from "./domain/repository";
import type { Branch, RepositorySnapshot } from "./domain/repository";
import { withOpenRepository } from "./useRepositoryRefs";
import type { RefsState } from "./useRepositoryRefs";
import { freshSnapshot } from "./useWorkspace";

const root = rootSchema.parse("/work/l1-demo");
const oid = oidSchema.parse("a".repeat(40));
const branch = (name: string): Branch => ({
  kind: "local",
  reference: refSchema.parse(`refs/heads/${name}`),
  name,
  oid,
  upstream: null,
});
const head = { kind: "detached" as const, oid };
const cached: RepositorySnapshot = {
  root,
  name: "l1-demo",
  head,
  branches: [branch("main")],
  tags: [],
  worktrees: [],
  remotes: [],
  commits: [],
  squashes: [],
  historyTruncated: false,
  observedAt: 1,
};

describe("the open repository's branches", () => {
  it("keeps fresher refs read in the background over a cached snapshot", () => {
    const states = new Map<typeof root, RefsState>([
      [
        root,
        {
          kind: "ready",
          refs: {
            root,
            name: "l1-demo",
            head,
            branches: [branch("main"), branch("zz-race")],
          },
        },
      ],
    ]);
    expect(withOpenRepository(states, cached)).toBe(states);
  });

  it("shows the snapshot's branches until a refs read is ready", () => {
    const states = new Map<typeof root, RefsState>([
      [root, { kind: "loading" }],
    ]);
    expect(withOpenRepository(states, cached).get(root)).toEqual({
      kind: "ready",
      refs: cached,
    });
  });
});

describe("a fresh snapshot", () => {
  it("is only the one the workspace accepted from a read", () => {
    const ready = { kind: "ready" as const, snapshot: cached, error: null };
    expect(freshSnapshot(ready)).toBe(cached);
    expect(
      freshSnapshot({ kind: "loading", path: root, previous: ready }),
    ).toBeNull();
    expect(
      freshSnapshot({
        ...ready,
        error: { kind: "transport", message: "The bridge is down." },
      }),
    ).toBeNull();
    expect(freshSnapshot({ kind: "empty" })).toBeNull();
  });
});
