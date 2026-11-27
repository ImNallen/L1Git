import { describe, expect, it, vi } from "vitest";
import { pullRequestSchema } from "./domain/pullRequest";
import type { PullRequest } from "./domain/pullRequest";
import type { CommitsFetch, RangeFile, SinceReady } from "./domain/range";
import { oidSchema, rootSchema } from "./domain/repository";
import type { FilePatch } from "./domain/repository";
import { createFilesChanged, shownFiles } from "./filesChanged";

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const root = rootSchema.parse("/work/app");
const repository = {
  key: "octo/app",
  name: "app",
  root,
  github: { owner: "octo", repo: "app" },
};
const base = oid("b");
const mergeBase = oid("a");

function pull(head: string, fields: Partial<PullRequest> = {}): PullRequest {
  const page = { items: [], total: 0 };
  return pullRequestSchema.parse({
    id: "PR_1",
    repositoryId: "R_1",
    number: 1,
    title: "One",
    body: "",
    state: { kind: "open", draft: false },
    author: "maja",
    viewerIsAuthor: false,
    viewerPermission: "write",
    base: "main",
    baseOid: base,
    labels: page,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    createdAt: "2026-11-24T10:00:00Z",
    updatedAt: "2026-11-24T10:00:00Z",
    head: {
      branch: "topic",
      oid: oid(head),
      repository: null,
      crossRepository: false,
      maintainerCanModify: false,
      ref: { id: "REF_1", othersOpen: 0, viewerCanDelete: true },
    },
    reviewers: [],
    reviewed: null,
    checks: null,
    commits: page,
    timeline: page,
    threads: page,
    mergeable: "unknown",
    mergeState: "unknown",
    decision: null,
    merge: {
      allowed: { merge: true, squash: true, rebase: true },
      preferred: "merge",
      deletesBranch: false,
    },
    pending: { kind: "none" },
    ...fields,
  });
}

const file = (path: string, fields: Partial<RangeFile> = {}): RangeFile => ({
  path,
  status: "M",
  from: null,
  similarity: null,
  added: 1,
  deleted: 1,
  oldBlob: oid("1"),
  newBlob: oid("2"),
  oldMode: "100644",
  newMode: "100644",
  submodule: false,
  ...fields,
});
const text = (patch: string): FilePatch => ({
  kind: "text",
  patch,
  lossy: false,
});
const ready = (
  files: RangeFile[],
  { contentMissing = false, shallow = false } = {},
) => ({ kind: "ready", mergeBase, files, contentMissing, shallow }) as const;
const replayed = oid("5");
const sinceReady = (
  files: RangeFile[],
  reviewed: RangeFile[] = [],
): SinceReady => ({
  kind: "ready",
  since: replayed,
  fromBase: { kind: "leftOut" },
  reviewed,
  files,
  contentMissing: false,
});
const missing = (...heads: string[]) =>
  ({ kind: "missing", oids: heads.map(oid) }) as const;

type Deps = Parameters<typeof createFilesChanged>[0];

/** Answers each read with the next of what is given, and then with the last. */
function setup(deps: Partial<Deps> = {}) {
  const files = [file("b.ts"), file("a.ts")];
  const given: Deps = {
    rangeFiles: vi.fn<Deps["rangeFiles"]>(async () => ready(files)),
    rangePatches: vi.fn<Deps["rangePatches"]>(async () =>
      files.map(({ path }) => ({ path, patch: text(path) })),
    ),
    filePatch: vi.fn<Deps["filePatch"]>(async (_, __, path) =>
      text(`own ${path}`),
    ),
    fetchCommits: vi.fn<Deps["fetchCommits"]>(async () => ({ kind: "done" })),
    sinceReview: vi.fn<Deps["sinceReview"]>(async () => sinceReady([])),
    ...deps,
  };
  const store = createFilesChanged(given);
  const kinds: string[] = [];
  store.subscribe(() => {
    const kind = store.read()?.read.kind ?? "closed";
    if (kinds.at(-1) !== kind) kinds.push(kind);
  });
  return {
    ...given,
    store,
    kinds,
    paths: () => {
      const read = store.read()?.read;
      return read?.kind === "ready" ? read.files.map(({ path }) => path) : null;
    },
    /** What the current file's patch is. */
    patch: () => {
      const held = store.read();
      if (held?.read.kind !== "ready") return null;
      const current = held.read.files[held.at];
      const read = current && held.patches?.get(current);
      return read?.kind === "ready" && read.patch.kind === "text"
        ? read.patch.patch
        : (read?.kind ?? null);
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("reading a range", () => {
  it("reads the files and every patch, once, in the order of the tree", async () => {
    const { store, kinds, paths, patch, ...deps } = setup();
    store.see("me one", repository, pull("1"), false);
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(kinds).toEqual(["reading", "ready"]);
    expect(deps.rangeFiles).toHaveBeenCalledExactlyOnceWith(
      root,
      base,
      oid("1"),
    );
    expect(deps.rangePatches).toHaveBeenCalledExactlyOnceWith(
      root,
      mergeBase,
      oid("1"),
    );
    expect(deps.fetchCommits).not.toHaveBeenCalled();
    expect(paths()).toEqual(["a.ts", "b.ts"]);
    expect(patch(), "each file has its own").toBe("a.ts");
    store.go(1);
    expect(patch()).toBe("b.ts");
    expect(deps.filePatch).not.toHaveBeenCalled();
  });

  it("asks for nothing more when nothing changed or no contents are here", async () => {
    for (const answer of [
      ready([]),
      ready([file("a.ts")], { contentMissing: true }),
    ]) {
      const { store, ...deps } = setup({ rangeFiles: async () => answer });
      store.see("me one", repository, pull("1"), false);
      await settle();
      store.go(1);
      await settle();
      expect(deps.rangePatches).not.toHaveBeenCalled();
      expect(deps.filePatch).not.toHaveBeenCalled();
    }
  });

  it("reads a file by itself, from its old path, once it is the current one", async () => {
    const files = [file("a.ts"), file("b.ts", { status: "R", from: "old.ts" })];
    const { store, patch, filePatch } = setup({
      rangeFiles: async () => ready(files),
      rangePatches: async () => [
        { path: "a.ts", patch: text("a.ts") },
        { path: "b.ts", patch: null },
      ],
    });
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(filePatch).not.toHaveBeenCalled();
    store.go(1);
    expect(patch()).toBe("reading");
    await settle();
    expect(patch()).toBe("own b.ts");
    const ends = {
      base: { kind: "commit", oid: mergeBase },
      target: { kind: "commit", oid: oid("1") },
    };
    expect(filePatch).toHaveBeenCalledExactlyOnceWith(
      root,
      ends,
      "b.ts",
      "hunks",
      "old.ts",
    );
    store.go(0);
    store.go(1);
    await settle();
    expect(filePatch).toHaveBeenCalledTimes(1);
    expect(await store.whole(files[0]!)).toBe("own a.ts");
    expect(filePatch).toHaveBeenLastCalledWith(
      root,
      ends,
      "a.ts",
      "whole",
      "a.ts",
    );
  });

  it("reads the current file by itself when the patches can't be read", async () => {
    const { store, patch } = setup({
      rangePatches: () => Promise.reject(new Error("too long")),
    });
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(patch()).toBe("own a.ts");
  });

  it("says why a file can't be read, and reads it again when asked", async () => {
    let fails = true;
    const files = [file("b.ts"), file("a.ts")];
    const { store, patch, filePatch } = setup({
      rangeFiles: async () => ready(files),
      rangePatches: async () => [],
      filePatch: vi.fn<Deps["filePatch"]>(async () => {
        if (fails) throw new Error("no");
        return text("at last");
      }),
    });
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(patch()).toBe("failed");
    await settle();
    expect(filePatch).toHaveBeenCalledTimes(1);
    fails = false;
    store.readFileAgain(files[1]!);
    await settle();
    expect(patch()).toBe("at last");
  });
});

describe("a fresher read on its way", () => {
  const heads = (rangeFiles: Deps["rangeFiles"]) =>
    vi.mocked(rangeFiles).mock.calls.map(([, , head]) => head);

  it("is the one that is pinned when it lands", async () => {
    const { store, rangeFiles } = setup();
    store.see("me one", repository, pull("1"), true);
    store.see("me one", repository, pull("1"), true);
    await settle();
    expect(store.read()?.read.kind).toBe("reading");
    expect(rangeFiles).not.toHaveBeenCalled();
    store.see("me one", repository, pull("2"), false);
    await settle();
    expect(heads(rangeFiles)).toEqual([oid("2")]);
    expect(store.read()?.range.head).toBe(oid("2"));
    store.see("me one", repository, pull("3"), true);
    store.see("me one", repository, pull("3"), false);
    await settle();
    expect(heads(rangeFiles), "only the first look waits").toEqual([oid("2")]);
  });

  it("is not waited for after it fails", async () => {
    const { store, rangeFiles } = setup();
    const last = pull("1");
    store.see("me one", repository, last, true);
    store.see("me one", repository, last, false);
    await settle();
    expect(heads(rangeFiles)).toEqual([oid("1")]);
  });

  it("is not waited for longer than a second", async () => {
    vi.useFakeTimers();
    const { store, rangeFiles } = setup();
    store.see("me one", repository, pull("1"), true);
    vi.advanceTimersByTime(999);
    expect(rangeFiles).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(heads(rangeFiles)).toEqual([oid("1")]);
    vi.useRealTimers();
    store.see("me one", repository, pull("2"), false);
    await settle();
    expect(store.read()?.range.head, "what is pinned stays").toBe(oid("1"));
  });

  it("is not waited for by a tab that closed", () => {
    vi.useFakeTimers();
    const { store, rangeFiles } = setup();
    store.see("me one", repository, pull("1"), true);
    store.close();
    vi.advanceTimersByTime(2_000);
    vi.useRealTimers();
    expect(rangeFiles).not.toHaveBeenCalled();
  });
});

describe("a range that is not what GitHub counts", () => {
  const counted = { changedFiles: 1, additions: 1, deletions: 1 };
  const otherwise = { ...counted, additions: 7 };
  async function read(
    answer: ReturnType<typeof ready>,
    fields: Partial<PullRequest>,
  ) {
    const { store } = setup({ rangeFiles: async () => answer });
    store.see("me one", repository, pull("1", fields), false);
    await settle();
    return { store, read: store.read()?.read };
  }

  it("is judged by the newest read of the same head and base", async () => {
    const { store } = await read(ready([file("a.ts")]), otherwise);
    const of = () => store.read()?.counted.additions;
    expect(of()).toBe(7);
    store.see("me one", repository, pull("1", counted), false);
    expect(of()).toBe(1);
    const elsewhere = pull("1", { ...otherwise, base: "next" });
    store.see("me one", repository, elsewhere, false);
    expect(of(), "of another base").toBe(1);
    expect(store.read()?.pull).toBe(elsewhere);
    store.see("me one", repository, pull("2", otherwise), false);
    expect(of(), "of another head").toBe(1);
    store.showNewest();
    expect(of()).toBe(7);
  });

  it("is judged by what came while it was read", async () => {
    const answer = deferred<ReturnType<typeof ready>>();
    const { store } = setup({ rangeFiles: () => answer.promise });
    store.see("me one", repository, pull("1", otherwise), false);
    store.see("me one", repository, pull("1", counted), false);
    answer.resolve(ready([file("a.ts")], { shallow: true }));
    await settle();
    expect(store.read()?.read.kind).toBe("ready");
  });

  it("does not show in a shallow clone, where it may start elsewhere", async () => {
    const shallow = ready([file("a.ts")], { shallow: true });
    expect((await read(shallow, counted)).read?.kind).toBe("ready");
    expect((await read(shallow, otherwise)).read).toEqual({
      kind: "stopped",
      stop: { kind: "unrelated", shallow: true },
    });
  });

  it("is not read in a partial clone without its folders", async () => {
    const { store } = setup({
      rangeFiles: async () => ({ kind: "treesMissing" }),
    });
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(store.read()?.read).toEqual({
      kind: "stopped",
      stop: { kind: "treesMissing" },
    });
  });
});

describe("a commit that is missing", () => {
  it("is fetched once, and then the range is read", async () => {
    const rangeFiles = vi
      .fn<Deps["rangeFiles"]>()
      .mockResolvedValueOnce(missing("1"))
      .mockResolvedValueOnce(ready([file("a.ts")]));
    const { store, kinds, fetchCommits } = setup({ rangeFiles });
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(kinds).toEqual(["reading", "fetching", "ready"]);
    expect(fetchCommits).toHaveBeenCalledExactlyOnceWith(
      root,
      repository.github,
      [oid("1")],
    );
  });

  it("is fetched with the base when both are missing", async () => {
    const { store, fetchCommits } = setup({
      rangeFiles: async () => missing("b", "1"),
    });
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(fetchCommits).toHaveBeenCalledExactlyOnceWith(
      root,
      repository.github,
      [base, oid("1")],
    );
    expect(store.read()?.read).toEqual({
      kind: "stopped",
      stop: { kind: "stillMissing" },
    });
  });

  it.each<CommitsFetch>([
    { kind: "noRemote" },
    { kind: "failed", failure: "auth", message: "Permission denied." },
  ])("is not fetched again until asked, after %j", async (got) => {
    const { store, fetchCommits } = setup({
      rangeFiles: async () => missing("1"),
      fetchCommits: vi.fn<Deps["fetchCommits"]>(async () => got),
    });
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(store.read()?.read).toEqual({ kind: "stopped", stop: got });
    store.see("me one", repository, pull("1", { title: "Read again" }), false);
    await settle();
    expect(fetchCommits).toHaveBeenCalledTimes(1);
    store.retry();
    await settle();
    expect(fetchCommits).toHaveBeenCalledTimes(2);
  });

  it("says why when the fetch itself is refused", async () => {
    const { store } = setup({
      rangeFiles: async () => missing("1"),
      fetchCommits: () =>
        Promise.reject({ kind: "lockHeld", message: "Another Git runs." }),
    });
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(store.read()?.read).toEqual({
      kind: "stopped",
      stop: { kind: "failed", failure: "other", message: "Another Git runs." },
    });
  });

  it("is not fetched for a tab that closed meanwhile", async () => {
    const answer = deferred<ReturnType<typeof missing>>();
    const { store, fetchCommits } = setup({ rangeFiles: () => answer.promise });
    store.see("me one", repository, pull("1"), false);
    store.close();
    answer.resolve(missing("1"));
    await settle();
    expect(fetchCommits).not.toHaveBeenCalled();
  });

  it("is waited for, not asked for again, when the tab opens again", async () => {
    const got = deferred<CommitsFetch>();
    const rangeFiles = vi
      .fn<Deps["rangeFiles"]>()
      .mockResolvedValueOnce(missing("1"))
      .mockResolvedValueOnce(missing("1"))
      .mockResolvedValue(ready([file("a.ts")]));
    const { store, paths, fetchCommits } = setup({
      rangeFiles,
      fetchCommits: vi.fn(() => got.promise),
    });
    store.see("me one", repository, pull("1"), false);
    await settle();
    store.close();
    store.see("me one", repository, pull("1"), false);
    await settle();
    expect(store.read()?.read.kind).toBe("fetching");
    got.resolve({ kind: "done" });
    await settle();
    expect(fetchCommits).toHaveBeenCalledTimes(1);
    expect(paths()).toEqual(["a.ts"]);
    expect(rangeFiles).toHaveBeenCalledTimes(3);
  });
});

it("says why a clone can't be read, and why two histories are none", async () => {
  const problem = { kind: "missingPath", message: "It is gone." } as const;
  const gone = setup({ rangeFiles: () => Promise.reject(problem) });
  gone.store.see("me one", repository, pull("1"), false);
  await settle();
  expect(gone.store.read()?.read).toEqual({
    kind: "stopped",
    stop: { kind: "unreadable", problem },
  });
  const unrelated = setup({
    rangeFiles: async () => ({ kind: "unrelated", shallow: true }),
  });
  unrelated.store.see("me one", repository, pull("1"), false);
  await settle();
  expect(unrelated.store.read()?.read).toEqual({
    kind: "stopped",
    stop: { kind: "unrelated", shallow: true },
  });
});

describe("a late answer", () => {
  it("shows under no other pull request or sign-in", async () => {
    const late = deferred<ReturnType<typeof ready>>();
    const rangeFiles = vi
      .fn<Deps["rangeFiles"]>()
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue(ready([file("new.ts")]));
    const { store, paths } = setup({ rangeFiles });
    store.see("me one", repository, pull("1"), false);
    store.close();
    store.see("other", repository, pull("2"), false);
    await settle();
    late.resolve(ready([file("late.ts")]));
    await settle();
    expect(store.read()?.of).toBe("other");
    expect(paths()).toEqual(["new.ts"]);
  });

  it("shows nothing after the tab closed", async () => {
    const late = deferred<ReturnType<typeof ready>>();
    const { store } = setup({ rangeFiles: () => late.promise });
    store.see("me one", repository, pull("1"), false);
    store.close();
    late.resolve(ready([file("late.ts")]));
    await settle();
    expect(store.read()).toBeNull();
  });
});

describe("a newer read", () => {
  it("is taken for its threads and counts while the head is the same", async () => {
    const { store, rangeFiles } = setup();
    const first = pull("1");
    store.see("me one", repository, first, false);
    await settle();
    store.go(1);
    const again = pull("1", { title: "Again", base: "next" });
    store.see("me one", repository, again, false);
    expect(store.read()).toMatchObject({ pull: again, at: 1 });
    expect(store.read()?.range.base).toBe("main");
    store.see("me one", repository, pull("2"), false);
    await settle();
    expect(store.read()).toMatchObject({ pull: again, at: 1 });
    expect(rangeFiles).toHaveBeenCalledTimes(1);
  });

  it("is shown when asked for, at the same file", async () => {
    const { store, paths, rangeFiles } = setup();
    store.see("me one", repository, pull("1"), false);
    await settle();
    store.go(1);
    const newer = pull("2", { base: "next" });
    store.see("me one", repository, newer, false);
    vi.mocked(rangeFiles).mockResolvedValue(
      ready(["0.ts", "a.ts", "b.ts"].map((path) => file(path))),
    );
    store.showNewest();
    expect(store.read()?.read.kind).toBe("reading");
    await settle();
    expect(rangeFiles).toHaveBeenLastCalledWith(root, base, oid("2"));
    expect(paths()).toEqual(["0.ts", "a.ts", "b.ts"]);
    expect(store.read()).toMatchObject({
      pull: newer,
      range: { base: "next", head: oid("2") },
      at: 2,
    });
  });
});

it("steps to files there are, and says where to begin in one", async () => {
  const { store } = setup();
  store.see("me one", repository, pull("1"), false);
  await settle();
  store.go(1, "end");
  expect(store.read()).toMatchObject({ at: 1, enter: "end" });
  store.go(2);
  store.go(-1);
  expect(store.read()?.at).toBe(1);
});

describe("what changed since your review", () => {
  const reviewedOid = oid("e");
  const at = "2026-11-24T18:00:00Z";
  const reviewedPull = (head: string) =>
    pull(head, { reviewed: { oid: reviewedOid, at } });
  const shown = (store: ReturnType<typeof setup>["store"]) => {
    const held = store.read();
    return held ? shownFiles(held).map(({ path }) => path) : null;
  };

  it("is read after the range, shown first, and its files read from where it starts", async () => {
    const again = file("b.ts", { oldBlob: oid("9") });
    const { store, ...deps } = setup({
      sinceReview: vi.fn<Deps["sinceReview"]>(async () =>
        sinceReady(
          [again],
          [file("a.ts"), file("b.ts", { newBlob: oid("8") })],
        ),
      ),
      rangePatches: vi.fn<Deps["rangePatches"]>(async (_, from) =>
        from === replayed
          ? [{ path: "b.ts", patch: text("since b.ts") }]
          : [
              { path: "b.ts", patch: text("b.ts") },
              { path: "a.ts", patch: text("a.ts") },
            ],
      ),
    });
    store.see("me one", repository, reviewedPull("1"), false);
    await settle();
    expect(deps.sinceReview).toHaveBeenCalledExactlyOnceWith(
      root,
      base,
      reviewedOid,
      oid("1"),
    );
    expect(deps.rangePatches).toHaveBeenLastCalledWith(
      root,
      replayed,
      oid("1"),
    );
    expect(shown(store)).toEqual(["b.ts"]);
    const held = store.read();
    const read = held?.patches?.get(again);
    expect(read?.kind === "ready" && read.patch).toEqual(text("since b.ts"));
    await store.whole(again);
    expect(deps.filePatch).toHaveBeenLastCalledWith(
      root,
      {
        base: { kind: "commit", oid: replayed },
        target: { kind: "commit", oid: oid("1") },
      },
      "b.ts",
      "whole",
      "b.ts",
    );
  });

  it("shows all changes at the same file in one step, and back", async () => {
    const { store } = setup({
      sinceReview: async () =>
        sinceReady([file("b.ts", { oldBlob: oid("9") })], [file("a.ts")]),
    });
    store.see("me one", repository, reviewedPull("1"), false);
    await settle();
    store.show("all");
    expect(shown(store)).toEqual(["a.ts", "b.ts"]);
    expect(store.read()?.at, "at b.ts").toBe(1);
    store.go(0);
    store.show("since");
    expect(store.read()?.at, "a.ts is not there").toBe(0);
  });

  it("fetches the commit you reviewed once, and then reads again", async () => {
    const sinceReview = vi
      .fn<Deps["sinceReview"]>()
      .mockResolvedValueOnce(missing("e"))
      .mockResolvedValueOnce(sinceReady([]));
    const { store, fetchCommits } = setup({ sinceReview });
    store.see("me one", repository, reviewedPull("1"), false);
    await settle();
    expect(fetchCommits).toHaveBeenCalledExactlyOnceWith(
      root,
      repository.github,
      [reviewedOid],
    );
    expect(sinceReview).toHaveBeenCalledTimes(2);
    expect(store.read()?.since?.read.kind).toBe("ready");
  });

  it("shows all changes when it stops, and reads again on Retry", async () => {
    const sinceReview = vi
      .fn<Deps["sinceReview"]>()
      .mockResolvedValueOnce({ kind: "treesMissing" })
      .mockResolvedValueOnce(sinceReady([]));
    const { store } = setup({ sinceReview });
    store.see("me one", repository, reviewedPull("1"), false);
    await settle();
    expect(store.read()?.since).toMatchObject({
      read: { kind: "stopped", stop: { kind: "treesMissing" } },
      showing: "all",
    });
    expect(shown(store)).toEqual(["a.ts", "b.ts"]);
    store.retrySince();
    await settle();
    expect(store.read()?.since).toMatchObject({
      read: { kind: "ready" },
      showing: "since",
    });
  });

  it("makes no Git call for a commit GitHub no longer has", async () => {
    const { store, sinceReview } = setup();
    store.see(
      "me one",
      repository,
      pull("1", { reviewed: { oid: null, at } }),
      false,
    );
    await settle();
    expect(sinceReview).not.toHaveBeenCalled();
    expect(store.read()?.since?.read).toEqual({
      kind: "stopped",
      stop: { kind: "gone" },
    });
    expect(shown(store)).toEqual(["a.ts", "b.ts"]);
  });

  it("compares a newer head with the same review, and keeps the view chosen", async () => {
    const { store, sinceReview } = setup();
    store.see("me one", repository, reviewedPull("1"), false);
    await settle();
    store.show("all");
    store.see("me one", repository, reviewedPull("2"), false);
    store.showNewest();
    await settle();
    expect(sinceReview).toHaveBeenLastCalledWith(
      root,
      base,
      reviewedOid,
      oid("2"),
    );
    expect(store.read()?.since?.showing).toBe("all");
  });
});
