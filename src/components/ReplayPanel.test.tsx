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
const blocked = (name: string) => {
  const found = button(name);
  return found.disabled || found.getAttribute("aria-disabled") === "true";
};
const finishReason = () => {
  const id = button("Finish cherry-pick").getAttribute("aria-describedby");
  return id === null ? null : document.getElementById(id)?.textContent;
};
const strip = () => host.querySelector(".operation-strip");
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
  ["cherryPick", "Cherry-picking", "onto", "cherry-pick"],
  ["revert", "Reverting", "on", "revert"],
])(
  "names the %s by its commit and the branch it lands on",
  async (kind, doing, onto, noun) => {
    await render(
      state({
        kind,
        conflicted: ["a.txt", "b.txt"],
        unresolved: ["a.txt", "b.txt"],
        tree: null,
      }),
    );
    expect(host.querySelector(".operation-title")?.textContent).toBe(
      `${doing} aaaaaaa Picked subject ${onto} main`,
    );
    expect(strip()?.textContent).toContain(
      `2 files still have conflicts. Resolve them, then finish the ${noun}.`,
    );
    expect(strip()?.textContent).toContain("0 of 2 resolved");
    expect(button(`Finish ${noun}`)).toBeDefined();
    expect(button(`Abort ${noun}…`)).toBeDefined();
  },
);

it("names a detached destination", async () => {
  await render(state({ destination: { kind: "detached", oid: head } }));
  expect(host.querySelector(".side-chip.current")?.textContent).toBe(
    "Detached HEAD",
  );
});

it("opens the inspector from the progress", async () => {
  await render(state());
  await act(async () => button("1 of 1 resolved").click());
  expect(inspect).toHaveBeenCalledOnce();
});

it("sends Finish through a write with the state the strip showed and the suggested message", async () => {
  await render(state());
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

it("blocks Finish with a reason for an unresolved path, an unsaved draft, an empty message, or while busy", async () => {
  await render(state({ unresolved: ["conflict.txt"], tree: null }));
  expect(blocked("Finish cherry-pick")).toBe(true);
  expect(finishReason()).toBe("Resolve every conflicted file first.");
  await act(async () => button("Finish cherry-pick").click());
  expect(write).not.toHaveBeenCalled();

  await render(state());
  expect(blocked("Finish cherry-pick")).toBe(false);
  expect(finishReason()).toBeNull();

  publishResolutionImpact([{ root: worktree, path: "conflict.txt" }]);
  await render(state());
  expect(finishReason()).toBe("Save your unsaved conflict results first.");
  expect(blocked("Abort cherry-pick…")).toBe(false);
  await act(async () => button("Finish cherry-pick").click());
  expect(write).not.toHaveBeenCalled();
  await act(async () => publishResolutionImpact([]));
  expect(blocked("Finish cherry-pick")).toBe(false);

  await render(state(), true);
  expect(finishReason()).toBe("Wait for the current operation to finish.");
  expect(blocked("Abort cherry-pick…")).toBe(true);

  setDraft(worktree, {
    draft: { summary: " ", description: "" },
    amend: null,
  });
  await render(state());
  expect(finishReason()).toBe("Write a commit message first.");
});

it("ignores unsaved drafts in other worktrees", async () => {
  publishResolutionImpact([{ root: rootSchema.parse("/other"), path: "x" }]);
  await render(state());
  expect(blocked("Finish cherry-pick")).toBe(false);
});

it("freezes the strip for a restart", async () => {
  await render(state());
  const freeze = freezeDrafts(draftImpact().revision);
  if (freeze.kind !== "frozen") throw new Error("Expected restart freeze");
  await render(state());
  expect(blocked("Abort cherry-pick…")).toBe(true);
  expect(finishReason()).toBe("Wait for L1 Git to restart.");
  await act(async () => freeze.release());
});

it("offers only Abort when the result matches HEAD, and says why", async () => {
  await render(state({ empty: true, tree: head }));
  expect(strip()?.textContent).toContain(
    "The staged result matches HEAD, so there is nothing to commit.",
  );
  expect(names()).toEqual(["1 of 1 resolved", "Abort cherry-pick…"]);
});

it("keeps Abort behind a confirmation, and the message draft through it", async () => {
  setDraft(worktree, {
    draft: { summary: "keep my message", description: "" },
    amend: null,
  });
  await render(state({ kind: "revert" }));
  await act(async () => button("Abort revert…").click());
  expect(abort).not.toHaveBeenCalled();
  expect(host.textContent).toContain(
    "A staged change outside the revert's files blocks Abort.",
  );
  expect(host.textContent).toContain("This cannot be undone.");
  await act(async () => button("Keep reverting").click());
  expect(abort).not.toHaveBeenCalled();
  await act(async () => button("Abort revert…").click());
  await act(async () => button("Abort revert").click());
  expect(abort).toHaveBeenCalledWith(
    worktree,
    { kind: "revert", commit },
    destination,
  );
  expect(draftOf(worktree).draft.summary).toBe("keep my message");
});

it("tells the user when Abort ended the operation, after the strip closes", async () => {
  await render(state());
  await act(async () => button("Abort cherry-pick…").click());
  await act(async () => button("Abort cherry-pick").click());
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
  "keeps the strip and shows %s from Abort",
  async (_, answer, text) => {
    abort.mockResolvedValue(answer);
    await render(state());
    await act(async () => button("Abort cherry-pick…").click());
    await act(async () => button("Abort cherry-pick").click());
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
                message: "My message\n",
              },
            }),
          }
        : ({
            kind: "failed",
            problem: { kind: answer, message: "Stopped.", output: "" },
          } as Awaited<ReturnType<typeof write>>),
    );
    setDraft(worktree, {
      draft: { summary: "My message", description: "" },
      amend: null,
    });
    await render(state());
    await act(async () => button("Finish cherry-pick").click());
    expect(draftOf(worktree).draft.summary).toBe(cleared ? "" : "My message");
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
  await act(async () => button("Finish cherry-pick").click());
  expect(host.querySelector(".problem-detail")?.textContent).toBe(
    "lint failed in conflict.txt",
  );
  await act(async () => button("Finish cherry-pick").click());
  expect(host.querySelector(".problem-detail")).toBeNull();
});

it("blocks Finish while a saved Amend is on", async () => {
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
  expect(finishReason()).toBe("Turn off Amend in the commit message first.");
  await act(async () =>
    setDraft(worktree, {
      draft: { summary: "unsent draft", description: "" },
      amend: null,
    }),
  );
  expect(blocked("Finish cherry-pick")).toBe(false);
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

it("shows an operation started in a terminal as read-only, and recovery as a merge", async () => {
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
  expect(host.querySelector(".operation-title")?.textContent).toBe(
    "A rebase is in progress",
  );
  expect(strip()?.textContent).toContain(
    "Started outside L1 Git. You can resolve files here, then continue or abort in your terminal.",
  );
  expect(names()).toEqual([]);
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
  expect(host.querySelector(".operation-title")?.textContent).toBe(
    "Merge needs attention",
  );
  expect(names()).toEqual(["Copy recovery steps"]);
});

it("leaves a cherry-pick or revert to the replay panel", async () => {
  await act(async () => root.render(controls(state())));
  expect(host.childElementCount).toBe(0);
});
