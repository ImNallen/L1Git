// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as repositories from "./repositories";
import { CommitBox } from "./components/CommitBox";
import { useWrites } from "./useWrites";
import type { Outcome } from "./useWrites";
import {
  appliedSchema,
  oidSchema,
  detailSchema,
  worktreeStatusSchema,
} from "./domain/repository";
import {
  clearSubmitted,
  draftImpact,
  draftOf,
  freezeDrafts,
  setDraft,
} from "./commitDrafts";

vi.mock("./repositories", () => ({
  mac: false,
  commitDetail: vi.fn(),
  undoHistory: vi.fn(),
  undo: vi.fn(),
}));
const status = worktreeStatusSchema.parse({
  root: "/fixture/draft-tasks",
  head: { kind: "attached", reference: "refs/heads/main", oid: "a".repeat(40) },
  entries: [],
  stagedStamp: "b".repeat(40),
});
const applied = appliedSchema.parse({
  id: "a".repeat(16),
  root: status.root,
  operation: {
    kind: "commit",
    message: "Undone message\n",
    staged: status.stagedStamp,
  },
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
let container: HTMLDivElement;
let reactRoot: ReturnType<typeof createRoot>;
const commit = vi.fn<Parameters<typeof CommitBox>[0]["onCommit"]>();
const reread = {
  worktree: vi.fn(async () => {}),
  refs: vi.fn(async () => {}),
  repository: vi.fn(),
};
function UndoView() {
  const writes = useWrites(status.root, reread);
  return <button onClick={() => void writes.undo()}>Undo</button>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});
afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
  clearSubmitted(status.root, draftOf(status.root));
  expect(draftImpact().tasks).toBe(0);
  vi.unstubAllGlobals();
});

it("holds an amend-loading task until the loaded message and amend-aside draft are applied", async () => {
  const result =
    deferred<Awaited<ReturnType<typeof repositories.commitDetail>>>();
  vi.mocked(repositories.commitDetail).mockReturnValue(result.promise);
  setDraft(status.root, {
    draft: { summary: "Aside", description: "" },
    amend: null,
  });
  await act(async () =>
    reactRoot.render(
      <CommitBox status={status} staged={0} busy={false} onCommit={commit} />,
    ),
  );
  const amend = container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!amend) throw new Error("No amend control");
  await act(async () => amend.click());
  expect(draftImpact().tasks).toBe(1);
  expect(freezeDrafts(draftImpact().revision)).toEqual({ kind: "busy" });
  const detail = detailSchema.parse({
    base: { kind: "firstParent" },
    target: { kind: "worktree", root: status.root, head: status.head },
    files: [],
  });
  await act(async () => result.resolve(detail));
  expect(draftOf(status.root).amend?.draftAside.summary).toBe("Aside");
  expect(draftImpact().tasks).toBe(0);
});

it("holds commit submission through draft clearing and refuses a new submission while frozen", async () => {
  const result = deferred<Outcome>();
  commit.mockReturnValue(result.promise);
  setDraft(status.root, {
    draft: { summary: "Submit me", description: "" },
    amend: null,
  });
  await act(async () =>
    reactRoot.render(
      <CommitBox status={status} staged={1} busy={false} onCommit={commit} />,
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  expect(draftImpact().tasks).toBe(1);
  expect(freezeDrafts(draftImpact().revision)).toEqual({ kind: "busy" });
  await act(async () => result.resolve({ kind: "applied", applied }));
  expect(draftOf(status.root).draft.summary).toBe("");
  expect(draftImpact().tasks).toBe(0);
  let release: (() => void) | null = null;
  await act(async () => {
    setDraft(status.root, {
      draft: { summary: "Keep me", description: "" },
      amend: null,
    });
    const freeze = freezeDrafts(draftImpact().revision);
    if (freeze.kind !== "frozen") throw new Error("Cannot freeze");
    release = freeze.release;
  });
  expect(container.querySelector("input")?.readOnly).toBe(true);
  await act(async () => container.querySelector("button")?.click());
  expect(commit).toHaveBeenCalledTimes(1);
  await act(async () => release?.());
  expect(draftOf(status.root).draft.summary).toBe("Keep me");
});

it("tracks undo through restoration and rereads, even after the native response arrives", async () => {
  vi.mocked(repositories.undoHistory).mockResolvedValue({
    undo: applied,
    redo: null,
  });
  const result = deferred<typeof applied>();
  const rereadResult = deferred<void>();
  vi.mocked(repositories.undo).mockReturnValue(result.promise);
  reread.refs.mockReturnValueOnce(rereadResult.promise);
  await act(async () => reactRoot.render(<UndoView />));
  await act(async () => container.querySelector("button")?.click());
  expect(draftImpact().tasks).toBe(1);
  await act(async () => result.resolve(applied));
  expect(draftOf(status.root).draft.summary).toBe("Undone message");
  expect(draftImpact().tasks).toBe(1);
  expect(freezeDrafts(draftImpact().revision)).toEqual({ kind: "busy" });
  await act(async () => rereadResult.resolve());
  expect(draftImpact().tasks).toBe(0);
  const frozen = freezeDrafts(draftImpact().revision);
  if (frozen.kind !== "frozen") throw new Error("Cannot freeze");
  await act(async () => container.querySelector("button")?.click());
  expect(repositories.undo).toHaveBeenCalledTimes(1);
  frozen.release();
});

it("defers a stale amend restoration during freeze and applies it when the freeze releases", async () => {
  setDraft(status.root, {
    draft: { summary: "Amending", description: "" },
    amend: {
      draftAside: { summary: "Aside", description: "" },
      loaded: {
        draft: { summary: "Amending", description: "" },
        message: "Amending",
      },
      head: oidSchema.parse("a".repeat(40)),
    },
  });
  await act(async () =>
    reactRoot.render(
      <CommitBox status={status} staged={0} busy={false} onCommit={commit} />,
    ),
  );
  const moved = worktreeStatusSchema.parse({
    ...status,
    head: { ...status.head, oid: "c".repeat(40) },
  });
  let release: (() => void) | null = null;
  await act(async () => {
    const freeze = freezeDrafts(draftImpact().revision);
    if (freeze.kind !== "frozen") throw new Error("Cannot freeze");
    release = freeze.release;
    reactRoot.render(
      <CommitBox status={moved} staged={0} busy={false} onCommit={commit} />,
    );
  });
  expect(draftOf(status.root).draft.summary).toBe("Amending");
  expect(draftOf(status.root).amend?.draftAside.summary).toBe("Aside");
  await act(async () => release?.());
  expect(draftOf(status.root).amend).toBeNull();
  expect(draftOf(status.root).draft.summary).toBe("Aside");
});
