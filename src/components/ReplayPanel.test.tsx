// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MergeControls } from "./MergeControls";
import { ReplayPanel } from "./ReplayPanel";
import { clearSubmitted, draftOf, setDraft } from "../commitDrafts";
import { mergeStateSchema } from "../domain/merge";
import type { ReplayProgress } from "../domain/merge";
import { loadMessage } from "../domain/commitMessage";
import { appliedSchema, oidSchema, rootSchema } from "../domain/repository";
import {
  draftImpact,
  freezeDrafts,
  publishResolutionImpact,
} from "../draftProtection";

const commit = "a".repeat(40);
const head = "b".repeat(40);
const staged = "c".repeat(40);
const tree = "d".repeat(40);
const worktree = rootSchema.parse("/fixture/replay");
const destination = {
  kind: "attached",
  reference: "refs/heads/main",
  oid: head,
};
const state = (progress: Partial<Record<keyof ReplayProgress, unknown>> = {}) =>
  mergeStateSchema.parse({
    kind: "replay",
    progress: {
      root: worktree,
      kind: "cherryPick",
      commit,
      subject: "Picked subject",
      destination,
      footprint: ["conflict.txt"],
      conflicted: ["conflict.txt"],
      unresolved: [],
      staged,
      tree,
      empty: false,
      suggestedMessage: "Picked subject\n\nBody line\n",
      ...progress,
    },
  });

const write = vi.fn<Parameters<typeof ReplayPanel>[0]["write"]>();
const abort = vi.fn<Parameters<typeof ReplayPanel>[0]["abort"]>();
const inspect = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const panel = (
  value: ReturnType<typeof state> | { kind: "idle" },
  busy = false,
) => (
  <ReplayPanel
    root={worktree}
    read={{ kind: "ready", value }}
    busy={busy}
    write={write}
    abort={abort}
    dismiss={vi.fn()}
    review={null}
    onCloseReview={vi.fn()}
    onInspect={inspect}
  />
);
const render = (value: ReturnType<typeof state>, busy = false) =>
  act(async () => root.render(panel(value, busy)));

function button(name: string) {
  const found = [...host.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No ${name}`);
  return found;
}
const names = () =>
  [...host.querySelectorAll("button")].map((item) => item.textContent?.trim());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  write.mockResolvedValue({ kind: "busy" });
  abort.mockResolvedValue({ kind: "aborted" });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  publishResolutionImpact([]);
  clearSubmitted(worktree, draftOf(worktree));
  vi.unstubAllGlobals();
});

it.each([
  ["cherryPick", "Cherry-pick in progress", "cherry-pick"],
  ["revert", "Revert in progress", "revert"],
])(
  "names the %s, its commit, and its destination",
  async (kind, title, noun) => {
    await render(state({ kind, unresolved: ["a.txt", "b.txt"], tree: null }));
    expect(host.querySelector("strong")?.textContent).toBe(title);
    expect(host.textContent).toContain("Picked subject");
    expect(host.textContent).toContain(commit);
    expect(host.textContent).toContain("refs/heads/main");
    expect(host.textContent).toContain(head);
    expect(host.textContent).toContain("2 unresolved paths");
    expect(button(`Finish ${noun}`)).toBeDefined();
    expect(button(`Abort ${noun}…`)).toBeDefined();
  },
);

it("names a detached destination by its commit", async () => {
  await render(state({ destination: { kind: "detached", oid: head } }));
  expect(host.textContent).toContain("Detached HEAD");
  expect(host.textContent).toContain(head);
});

it("says what Undo and Abort can do", async () => {
  await render(state());
  expect(host.textContent).toContain("Finish can be undone like a commit.");
  expect(host.textContent).toContain("does not reopen the conflict");
  expect(host.textContent).toContain("Abort cannot be undone.");
  expect(host.textContent).toContain(
    "Resolution edits have Undo and Redo until Finish or Abort.",
  );
});

it("opens the resolver from the panel", async () => {
  await render(state());
  await act(async () => button("Review staged result and conflicts").click());
  expect(inspect).toHaveBeenCalledOnce();
});

it("sends Finish through a write with the state the panel showed", async () => {
  await render(state());
  await act(async () => button("Use suggested message").click());
  await act(async () => button("Finish cherry-pick").click());
  expect(write).toHaveBeenCalledWith(worktree, {
    operation: {
      kind: "finishReplay",
      of: { kind: "cherryPick", commit },
      staged,
      tree,
      message: "Picked subject\n\nBody line\n",
    },
    expect: { head: destination },
  });
});

it("disables Finish with an unresolved path, an unsaved draft, an empty message, or while busy", async () => {
  await render(state({ unresolved: ["conflict.txt"], tree: null }));
  await act(async () => button("Use suggested message").click());
  expect(button("Finish cherry-pick").disabled).toBe(true);

  await render(state());
  expect(button("Finish cherry-pick").disabled).toBe(false);

  publishResolutionImpact([{ root: worktree, path: "conflict.txt" }]);
  await render(state());
  expect(button("Finish cherry-pick").disabled).toBe(true);
  expect(button("Abort cherry-pick…").disabled).toBe(false);
  expect(host.textContent).toContain("Unsaved conflict results");
  await act(async () => button("Finish cherry-pick").click());
  expect(write).not.toHaveBeenCalled();
  await act(async () => publishResolutionImpact([]));
  expect(button("Finish cherry-pick").disabled).toBe(false);

  await render(state(), true);
  expect(button("Finish cherry-pick").disabled).toBe(true);
  expect(button("Abort cherry-pick…").disabled).toBe(true);

  await act(async () => clearSubmitted(worktree, draftOf(worktree)));
  await render(state());
  expect(button("Finish cherry-pick").disabled).toBe(true);
});

it("ignores unsaved drafts in other worktrees", async () => {
  publishResolutionImpact([{ root: rootSchema.parse("/other"), path: "x" }]);
  await render(state());
  await act(async () => button("Use suggested message").click());
  expect(button("Finish cherry-pick").disabled).toBe(false);
});

it("freezes the panel for a restart", async () => {
  await render(state());
  const freeze = freezeDrafts(draftImpact().revision);
  if (freeze.kind !== "frozen") throw new Error("Expected restart freeze");
  await render(state());
  expect(button("Abort cherry-pick…").disabled).toBe(true);
  expect(button("Use suggested message").disabled).toBe(true);
  expect(host.querySelector("textarea")?.readOnly).toBe(true);
  await act(async () => freeze.release());
});

it("offers only Abort when the result matches HEAD, and says why", async () => {
  await render(state({ empty: true, tree: head }));
  expect(host.textContent).toContain(
    "The staged result matches HEAD, so there is nothing to commit.",
  );
  expect(names()).toEqual([
    "Review staged result and conflicts",
    "Abort cherry-pick…",
  ]);
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.textContent).not.toContain("Finish can be undone");
});

it("keeps Abort behind a confirmation, and the message draft through it", async () => {
  setDraft(worktree, {
    draft: { summary: "keep my message", description: "" },
    amend: null,
  });
  await render(state({ kind: "revert" }));
  await act(async () => button("Abort revert…").click());
  expect(abort).not.toHaveBeenCalled();
  expect(host.textContent).toContain("A staged change outside those paths");
  expect(host.textContent).toContain("This action cannot be undone.");
  await act(async () => button("Cancel").click());
  expect(abort).not.toHaveBeenCalled();
  await act(async () => button("Abort revert…").click());
  await act(async () => button("Discard revert and abort").click());
  expect(abort).toHaveBeenCalledWith(
    worktree,
    { kind: "revert", commit },
    destination,
  );
  expect(draftOf(worktree).draft.summary).toBe("keep my message");
});

it("tells the user when Abort ended the operation, after the panel closes", async () => {
  await render(state());
  await act(async () => button("Abort cherry-pick…").click());
  await act(async () => button("Discard cherry-pick and abort").click());
  await act(async () => root.render(panel({ kind: "idle" })));
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Cherry-pick aborted.",
  );
});

it.each([
  [
    "a refusal",
    {
      kind: "failed",
      problem: { kind: "conflict", message: "Preserve x.txt." },
    },
    "Preserve x.txt.",
  ],
  ["a busy answer", { kind: "busy" }, "Wait for the current operation"],
] as const)(
  "keeps the panel and shows %s from Abort",
  async (_, answer, text) => {
    abort.mockResolvedValue(answer);
    await render(state());
    await act(async () => button("Abort cherry-pick…").click());
    await act(async () => button("Discard cherry-pick and abort").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(text);
    expect(button("Finish cherry-pick")).toBeDefined();
  },
);

it.each([
  ["applied", true],
  ["hookFailed", false],
  ["afterHookFailed", true],
  ["raced", true],
] as const)(
  "after Finish answers %s, clearing the message draft is %s",
  async (answer, cleared) => {
    write.mockResolvedValue(
      answer === "applied"
        ? {
            kind: "applied",
            applied: appliedSchema.parse({
              id: "0".repeat(16),
              root: worktree,
              operation: {
                kind: "finishReplay",
                of: { kind: "cherryPick", commit },
                staged,
                tree,
                message: "Picked subject\n",
              },
            }),
          }
        : ({
            kind: "failed",
            problem: { kind: answer, message: "Stopped.", output: "" },
          } as Awaited<ReturnType<typeof write>>),
    );
    await render(state());
    await act(async () => button("Use suggested message").click());
    await act(async () => button("Finish cherry-pick").click());
    expect(draftOf(worktree).draft.summary).toBe(
      cleared ? "" : "Picked subject",
    );
  },
);

it("shows what a refusing hook printed, as the Commit box does, until the next Finish", async () => {
  write.mockResolvedValueOnce({
    kind: "failed",
    problem: {
      kind: "hookFailed",
      message: "The hook stopped the commit.",
      output: "lint failed in conflict.txt",
    },
  });
  await render(state());
  await act(async () => button("Use suggested message").click());
  await act(async () => button("Finish cherry-pick").click());
  expect(host.querySelector(".problem-detail")?.textContent).toBe(
    "lint failed in conflict.txt",
  );
  await act(async () => button("Finish cherry-pick").click());
  expect(host.querySelector(".problem-detail")).toBeNull();
});

it("makes the user turn off a saved Amend before writing a message", async () => {
  const loaded = loadMessage("Previous commit\n");
  setDraft(worktree, {
    draft: loaded.draft,
    amend: {
      draftAside: { summary: "unsent draft", description: "" },
      loaded,
      head: oidSchema.parse(head),
    },
  });
  await render(state());
  expect(host.textContent).toContain("Amend is on");
  expect(host.querySelector("textarea")).toBeNull();
  expect(button("Finish cherry-pick").disabled).toBe(true);
  await act(async () => button("Turn off Amend").click());
  expect(draftOf(worktree).amend).toBeNull();
  expect(host.querySelector("input")?.value).toBe("unsent draft");
  expect(button("Finish cherry-pick").disabled).toBe(false);
});

it("shows nothing when Git holds no cherry-pick or revert", async () => {
  await act(async () => root.render(panel({ kind: "idle" })));
  expect(host.childElementCount).toBe(0);
});

const controls = (value: ReturnType<typeof mergeStateSchema.parse>) => (
  <MergeControls
    root={worktree}
    read={{ kind: "ready", value }}
    refresh={() => {}}
    eligible={false}
    busy={false}
    review={null}
    onReview={() => {}}
    onCloseReview={() => {}}
    run={async () => ({ kind: "busy" })}
    onInspect={() => {}}
  />
);

it("names an external operation as a Git operation and leaves recovery as a merge", async () => {
  await act(async () =>
    root.render(
      controls({
        kind: "attention",
        session: null,
        reason: "externalOperation",
        message: "A rebase is in progress.",
      }),
    ),
  );
  expect(host.querySelector("strong")?.textContent).toBe(
    "Git operation in progress",
  );
  expect(host.textContent).toContain("A rebase is in progress.");
  await act(async () =>
    root.render(
      controls({
        kind: "attention",
        session: null,
        reason: "recoveryRequired",
        message: "Preserve the session.",
      }),
    ),
  );
  expect(host.querySelector("strong")?.textContent).toBe(
    "Merge needs attention",
  );
});

it("leaves a cherry-pick or revert to the replay panel", async () => {
  await act(async () => root.render(controls(state())));
  expect(host.childElementCount).toBe(0);
});
