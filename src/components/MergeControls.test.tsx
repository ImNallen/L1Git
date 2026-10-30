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
  tracking: {
    remote: "origin",
    merge: "refs/heads/main",
    fetch: ["+refs/heads/*:refs/remotes/origin/*"],
  },
});
const active = mergeStateSchema.parse({
  kind: "active",
  session: {
    id: "a".repeat(16),
    review,
    footprint: ["conflict.txt"],
    suggestedMessage: "Merge origin/main into main",
  },
  unresolved: [],
  staged: "c".repeat(40),
  tree: "d".repeat(40),
  upstreamMoved: true,
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
  reviewOpen: false,
  onReview: () => {},
  onCloseReview: close,
  run,
  onInspect: () => {},
};
function button(name: string) {
  const button = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  );
  if (!button) throw new Error(`No ${name}`);
  return button;
}
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
  expect(host.querySelector('[aria-label="Upstream merge"]')).toBeNull();
  await act(async () =>
    root.render(<MergeControls {...props} read={{ kind: "loading" }} />),
  );
  expect(host.querySelector('[aria-label="Upstream merge"]')).toBeNull();
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
  await act(async () => button("Use suggested message").click());
  expect(button("Finish merge").disabled).toBe(true);
  expect(button("Abort merge…").disabled).toBe(false);
  expect(host.textContent).toContain("Unsaved conflict results");
  await act(async () => button("Finish merge").click());
  expect(run).not.toHaveBeenCalled();
  await act(async () => publishResolutionImpact([]));
  expect(button("Finish merge").disabled).toBe(false);
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
        reviewOpen
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
        reviewOpen
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
it("requires a message, permits an empty-tree merge, and binds the reviewed staged result", async () => {
  await act(async () => root.render(<MergeControls {...props} />));
  expect(button("Finish merge").disabled).toBe(true);
  expect(host.textContent).toContain("upstream has moved");
  await act(async () => button("Use suggested message").click());
  expect(button("Finish merge").disabled).toBe(false);
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
  await act(async () => button("Cancel").click());
  expect(run).not.toHaveBeenCalled();
  await act(async () => button("Abort merge…").click());
  await act(async () => button("Discard merge and abort").click());
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
  expect(host.querySelector("textarea")).toBeNull();
  await act(async () => root.render(<MergeControls {...props} />));
  const freeze = freezeDrafts(draftImpact().revision);
  if (freeze.kind !== "frozen") throw new Error("Expected restart freeze");
  await act(async () => root.render(<MergeControls {...props} />));
  expect(button("Abort merge…").disabled).toBe(true);
  expect(host.querySelector("textarea")?.readOnly).toBe(true);
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
  await act(async () => button("Use suggested message").click());
  await act(async () => button("Finish merge").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "other.txt",
  );
  expect(refresh).toHaveBeenCalled();
});
