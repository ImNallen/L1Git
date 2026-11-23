// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { MergeControls } from "./MergeControls";
import * as repositories from "../repositories";
import { mergeStateSchema, mergeReviewSchema } from "../domain/merge";
import { clearSubmitted, draftOf, setDraft } from "../commitDrafts";
import {
  draftImpact,
  freezeDrafts,
  publishResolutionImpact,
} from "../draftProtection";
import { loadMessage } from "../domain/commitMessage";

vi.mock("../repositories", () => ({ mergeReview: vi.fn() }));
const review = mergeReviewSchema.parse({
  root: "/fixture/merge",
  destination: { reference: "refs/heads/main", oid: "a".repeat(40) },
  source: { reference: "refs/remotes/origin/main", oid: "b".repeat(40) },
  plan: "mergeCommit",
  context: {
    kind: "upstream",
    tracking: {
      remote: "origin",
      merge: "refs/heads/main",
      fetch: ["+refs/heads/*:refs/remotes/origin/*"],
    },
  },
});
const active = mergeStateSchema.parse({
  kind: "active",
  session: {
    id: "a".repeat(16),
    review,
    footprint: ["conflict.txt"],
    conflicted: ["conflict.txt"],
    suggestedMessage: "Merge origin/main into main",
  },
  unresolved: [],
  staged: "c".repeat(40),
  tree: "d".repeat(40),
  sourceMoved: true,
});
const run = vi.fn<Parameters<typeof MergeControls>[0]["run"]>();
const refresh = vi.fn();
const close = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const props: Parameters<typeof MergeControls>[0] = {
  root: review.root,
  read: { kind: "ready", value: active },
  refresh,
  eligible: false,
  busy: false,
  review: null,
  onReview: () => {},
  onCloseReview: close,
  run,
  onInspect: () => {},
  onConflicts: () => {},
};
function button(name: string) {
  const button = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  );
  if (!button) throw new Error(`No ${name}`);
  return button;
}
const blocked = (name: string) => {
  const found = button(name);
  return found.disabled || found.getAttribute("aria-disabled") === "true";
};
const finishReason = () => {
  const id = button("Finish merge").getAttribute("aria-describedby");
  return id === null ? null : document.getElementById(id)?.textContent;
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  run.mockResolvedValue({
    kind: "merged",
    report: { state: { kind: "idle" }, outcome: { kind: "aborted" } },
  });
  vi.mocked(repositories.mergeReview).mockResolvedValue(review);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  publishResolutionImpact([]);
  clearSubmitted(review.root, draftOf(review.root));
  vi.unstubAllGlobals();
});
it("keeps the ordinary history free of an idle or loading merge panel", async () => {
  await act(async () =>
    root.render(
      <MergeControls
        {...props}
        read={{ kind: "ready", value: { kind: "idle" } }}
      />,
    ),
  );
  expect(host.querySelector('[aria-label="Branch merge"]')).toBeNull();
  await act(async () =>
    root.render(<MergeControls {...props} read={{ kind: "loading" }} />),
  );
  expect(host.querySelector('[aria-label="Branch merge"]')).toBeNull();
});
it("offers a relevant merge action without the generic worktree and refresh toolbar", async () => {
  const onReview = vi.fn();
  await act(async () =>
    root.render(
      <MergeControls
        {...props}
        read={{ kind: "ready", value: { kind: "idle" } }}
        eligible
        onReview={onReview}
      />,
    ),
  );
  expect(host.querySelector('[aria-label="Merge worktree"]')).toBeNull();
  expect(host.textContent).not.toContain("Refresh merge");
  await act(async () => button("Merge upstream…").click());
  expect(onReview).toHaveBeenCalledOnce();
  await act(async () => root.render(<MergeControls {...props} />));
  expect(host.textContent).not.toContain("Refresh merge");
  expect(button("Finish merge")).toBeDefined();
  expect(button("Abort merge…")).toBeDefined();
});
it("protects unsaved conflict text from Finish while permitting reviewed Abort", async () => {
  publishResolutionImpact([{ root: review.root, path: "conflict.txt" }]);
  await act(async () => root.render(<MergeControls {...props} />));
  expect(blocked("Finish merge")).toBe(true);
  expect(finishReason()).toBe("Save your unsaved conflict results first.");
  expect(blocked("Abort merge…")).toBe(false);
  await act(async () => button("Finish merge").click());
  expect(run).not.toHaveBeenCalled();
  await act(async () => publishResolutionImpact([]));
  expect(blocked("Finish merge")).toBe(false);
});
it("keeps an amend's saved message protected before Start", async () => {
  const loaded = loadMessage("Previous commit\n");
  setDraft(review.root, {
    draft: loaded.draft,
    amend: {
      draftAside: { summary: "unsent draft", description: "" },
      loaded,
      head: review.destination.oid,
    },
  });
  await act(async () =>
    root.render(
      <MergeControls
        {...props}
        review={{ kind: "upstream" }}
        read={{ kind: "ready", value: { kind: "idle" } }}
      />,
    ),
  );
  expect(button("Start merge").disabled).toBe(true);
  expect(host.textContent).toContain("Turn off Amend");
  expect(draftOf(review.root).amend?.draftAside.summary).toBe("unsent draft");
});
it("reviews exact refs and OIDs and starts only after explicit Start", async () => {
  await act(async () =>
    root.render(
      <MergeControls
        {...props}
        review={{ kind: "upstream" }}
        read={{ kind: "ready", value: { kind: "idle" } }}
        eligible
      />,
    ),
  );
  expect(host.textContent).toContain(review.destination.oid);
  expect(host.textContent).toContain(review.source.oid);
  expect(host.textContent).toContain("cannot be undone");
  expect(run).not.toHaveBeenCalled();
  await act(async () => button("Start merge").click());
  expect(run).toHaveBeenCalledWith({ kind: "start", review });
});
it.each([
  [
    { kind: "conflict", paths: ["conflict.txt", "notes.txt"] },
    "Will conflict in: conflict.txt, notes.txt.",
  ],
  [{ kind: "clean" }, "Applies cleanly."],
  [null, "L1 Git cannot predict which paths will conflict."],
] as const)(
  "forecasts the merge commit's conflicts in the review (%j)",
  async (prediction, forecast) => {
    vi.mocked(repositories.mergeReview).mockResolvedValue({
      ...review,
      prediction,
    });
    await act(async () =>
      root.render(
        <MergeControls
          {...props}
          review={{ kind: "upstream" }}
          read={{ kind: "ready", value: { kind: "idle" } }}
          eligible
        />,
      ),
    );
    expect(host.textContent).toContain(forecast);
  },
);
it.each([
  ["stops on conflicts", ["conflict.txt"], 1],
  ["stops with no conflicts", [], 0],
])(
  "a start that %s closes the review and leads to the resolver only with conflicts",
  async (_, unresolved, leads) => {
    const onConflicts = vi.fn();
    run.mockResolvedValue({
      kind: "merged",
      report: {
        state: mergeStateSchema.parse({ ...active, unresolved, tree: null }),
        outcome: { kind: "started", problem: null },
      },
    });
    await act(async () =>
      root.render(
        <MergeControls
          {...props}
          review={{ kind: "upstream" }}
          read={{ kind: "ready", value: { kind: "idle" } }}
          eligible
          onConflicts={onConflicts}
        />,
      ),
    );
    await act(async () => button("Start merge").click());
    expect(close).toHaveBeenCalled();
    expect(onConflicts).toHaveBeenCalledTimes(leads);
  },
);
it("finishes with the suggested message unless edited, and binds the reviewed staged result", async () => {
  setDraft(review.root, {
    draft: { summary: " ", description: "" },
    amend: null,
  });
  await act(async () => root.render(<MergeControls {...props} />));
  expect(finishReason()).toBe("Write a commit message first.");
  expect(host.textContent).toContain("source branch has moved");
  await act(async () => clearSubmitted(review.root, draftOf(review.root)));
  expect(blocked("Finish merge")).toBe(false);
  await act(async () => button("Finish merge").click());
  expect(run).toHaveBeenCalledWith({
    kind: "finish",
    session: "a".repeat(16),
    staged: "c".repeat(40),
    tree: "d".repeat(40),
    message: "Merge origin/main into main\n",
  });
});
it("keeps Abort behind a discard confirmation and preserves the message draft", async () => {
  setDraft(review.root, {
    draft: { summary: "keep my message", description: "" },
    amend: null,
  });
  await act(async () => root.render(<MergeControls {...props} />));
  await act(async () => button("Abort merge…").click());
  expect(run).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Unrelated tracked changes block Abort");
  await act(async () => button("Keep merging").click());
  expect(run).not.toHaveBeenCalled();
  await act(async () => button("Abort merge…").click());
  await act(async () => button("Abort merge").click());
  expect(run).toHaveBeenCalledWith({ kind: "abort", session: "a".repeat(16) });
  expect(draftOf(review.root).draft.summary).toBe("keep my message");
});
it("shows recovery instructions without destructive continuation and freezes lifecycle controls", async () => {
  await act(async () =>
    root.render(
      <MergeControls
        {...props}
        read={{
          kind: "ready",
          value: {
            kind: "attention",
            reason: "recoveryRequired",
            session: null,
            message: "Preserve external changes.",
          },
        }}
      />,
    ),
  );
  expect(host.textContent).toContain("Preserve external changes.");
  expect(host.textContent).toContain("Merge needs attention");
  expect(host.textContent).not.toContain("Finish merge");
  expect(host.textContent).not.toContain("Abort merge");
  await act(async () => root.render(<MergeControls {...props} />));
  const freeze = freezeDrafts(draftImpact().revision);
  if (freeze.kind !== "frozen") throw new Error("Expected restart freeze");
  await act(async () => root.render(<MergeControls {...props} />));
  expect(button("Abort merge…").disabled).toBe(true);
  expect(finishReason()).toBe("Wait for L1 Git to restart.");
  await act(async () => freeze.release());
});
it("keeps a readable failure and refreshes state after a rejected Finish", async () => {
  run.mockResolvedValue({
    kind: "failed",
    problem: {
      kind: "conflict",
      message: "Preserve other.txt before aborting.",
    },
  });
  await act(async () => root.render(<MergeControls {...props} />));
  await act(async () => button("Finish merge").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "other.txt",
  );
  expect(refresh).toHaveBeenCalled();
});

it.each(["fastForward", "upToDate"] as const)(
  "explains the %s plan and keeps terminal outcomes out of the active panel",
  async (plan) => {
    const shown = {
      ...review,
      context: { kind: "branch" as const },
      plan,
      prediction: null,
    };
    vi.mocked(repositories.mergeReview).mockResolvedValue(shown);
    run.mockResolvedValue({
      kind: "merged",
      report: {
        state: { kind: "idle" },
        outcome: {
          kind: "fastForwarded",
          commit: shown.source.oid,
          problem: null,
        },
      },
    });
    await act(async () =>
      root.render(
        <MergeControls
          {...props}
          review={{ kind: "branch", reference: shown.source.reference }}
          read={{ kind: "ready", value: { kind: "idle" } }}
        />,
      ),
    );
    expect(vi.mocked(repositories.mergeReview)).toHaveBeenCalledWith(
      shown.root,
      { kind: "branch", reference: shown.source.reference },
    );
    expect(host.textContent).toContain(shown.source.oid);
    expect(host.textContent).toContain(shown.destination.oid);
    expect(host.textContent).not.toContain("Finish merge");
    expect(host.textContent).not.toContain("Abort merge…");
    expect(host.textContent).not.toContain("conflict");
    if (plan === "upToDate") {
      expect(host.textContent).toContain("No write is needed");
      expect(button("Start merge").disabled).toBe(true);
      expect(run).not.toHaveBeenCalled();
    } else {
      expect(host.textContent).toContain("without creating a merge commit");
      await act(async () => button("Fast-forward").click());
      expect(run).toHaveBeenCalledWith({ kind: "start", review: shown });
      expect(close).toHaveBeenCalled();
      expect(host.textContent).toContain("Fast-forwarded to");
    }
  },
);
