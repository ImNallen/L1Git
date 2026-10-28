import { describe, expect, it } from "vitest";
import { oidSchema, refSchema, rootSchema } from "./domain/repository";
import type {
  Branch,
  RepositoryRefs,
  RepositoryRoot,
} from "./domain/repository";
import type { RepositorySnapshot } from "./domain/repository";
import { RepositoryRefsStore, withOpenRepository } from "./useRepositoryRefs";
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
const noRefs = { tags: [], stashes: [], submodules: [] };
const cached: RepositorySnapshot = {
  root,
  name: "l1-demo",
  head,
  branches: [branch("main")],
  ...noRefs,
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
            ...noRefs,
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

describe("branches reported for pruning", () => {
  const other = rootSchema.parse("/work/sync-demo");
  const fresh: RepositorySnapshot = {
    ...cached,
    branches: [branch("main"), branch("zz-race")],
    observedAt: 2,
  };
  const ready = (snapshot: RepositorySnapshot) => ({
    kind: "ready" as const,
    snapshot,
    error: null,
  });

  function harness() {
    const reads: {
      root: RepositoryRoot;
      resolve: (refs: RepositoryRefs) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const reported: [RepositoryRoot, string[]][] = [];
    const store = new RepositoryRefsStore(
      (readRoot) =>
        new Promise((resolve, reject) =>
          reads.push({ root: readRoot, resolve, reject }),
        ),
      (reportedRoot, branches) =>
        reported.push([reportedRoot, branches.map((b) => b.name)]),
    );
    return { store, reads, reported };
  }
  const refsOf = (forRoot: RepositoryRoot, ...names: string[]) => ({
    root: forRoot,
    name: "repo",
    head,
    branches: names.map(branch),
    ...noRefs,
  });
  const settled = () => new Promise((resolve) => setTimeout(resolve));

  it("skips the cached snapshot shown while a repository rereads, then reports the accepted one", () => {
    const { store, reported } = harness();
    store.acceptFresh({ kind: "loading", path: root, previous: ready(cached) });
    expect(reported).toEqual([]);
    expect(store.states().has(root)).toBe(false);
    store.acceptFresh(ready(fresh));
    store.acceptFresh(ready(fresh));
    expect(reported).toEqual([[root, ["main", "zz-race"]]]);
  });

  it("keeps a fresh snapshot's tags, stashes, and submodules, and reports only its branches", () => {
    const { store, reported } = harness();
    const tagged: RepositorySnapshot = {
      ...fresh,
      tags: [
        {
          reference: refSchema.parse("refs/tags/v1"),
          name: "v1",
          oid,
          object: oid,
          annotated: false,
        },
      ],
      stashes: [
        { name: "stash@{0}", oid, message: "On main: wip", timestamp: 1 },
      ],
      submodules: [{ path: "vendor/lib", oid }],
    };
    store.acceptFresh(ready(tagged));
    expect(store.states().get(root)).toEqual({
      kind: "ready",
      refs: {
        root,
        name: "l1-demo",
        head,
        branches: tagged.branches,
        tags: tagged.tags,
        stashes: tagged.stashes,
        submodules: tagged.submodules,
      },
    });
    expect(reported).toEqual([[root, ["main", "zz-race"]]]);
  });

  it("reports the branches of each refs read that is still the latest", async () => {
    const { store, reads, reported } = harness();
    store.load([other]);
    store.load([other]);
    reads[1]?.resolve(refsOf(other, "main", "develop"));
    reads[0]?.resolve(refsOf(other, "main"));
    await settled();
    expect(reported).toEqual([[other, ["main", "develop"]]]);
    expect(store.states().get(other)).toEqual({
      kind: "ready",
      refs: refsOf(other, "main", "develop"),
    });
  });

  it("drops a refs read that an accepted snapshot or a collapse superseded", async () => {
    const { store, reads, reported } = harness();
    store.load([root, other]);
    store.acceptFresh(ready(fresh));
    store.forget([other]);
    reads[0]?.resolve(refsOf(root, "main"));
    reads[1]?.reject(new Error("gone"));
    await settled();
    expect(reported).toEqual([[root, ["main", "zz-race"]]]);
    expect(store.states().has(other)).toBe(false);
  });
});
