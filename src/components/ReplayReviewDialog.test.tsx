// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReplayPanel } from "./ReplayPanel";
import { mergeStateSchema } from "../domain/merge";
import type { MergeState } from "../domain/merge";
import {
  rootSchema,
  oidSchema,
  replayReviewSchema,
} from "../domain/repository";
import type {
  Problem,
  ReplayKind,
  ReplayPrediction,
} from "../domain/repository";
import { draftImpact, freezeDrafts } from "../draftProtection";
import * as repositories from "../repositories";

vi.mock("../repositories", () => ({ replayReview: vi.fn() }));

const worktree = rootSchema.parse("/fixture/replay");
const commit = oidSchema.parse("a".repeat(40));
const head = oidSchema.parse("b".repeat(40));
const tree = oidSchema.parse("d".repeat(40));
const CLEAN_PREDICTION =
  "Applies cleanly. L1 Git will commit it straight away, and Undo removes it.";

const reviewOf = (
  kind: ReplayKind,
  prediction: ReplayPrediction = { kind: "clean", tree },
) =>
  replayReviewSchema.parse({
    root: worktree,
    kind,
    commit,
    subject: "Picked subject",
    destination: { reference: "refs/heads/main", oid: head },
    prediction,
  });

const replayState = (): MergeState =>
  mergeStateSchema.parse({
    kind: "replay",
    progress: {
      root: worktree,
      kind: "cherryPick",
      commit,
      subject: "Picked subject",
      destination: {
        kind: "attached",
        reference: "refs/heads/main",
        oid: head,
      },
      footprint: ["conflict.txt"],
      conflicted: ["conflict.txt"],
      unresolved: ["conflict.txt"],
      staged: "c".repeat(40),
      tree: null,
      empty: false,
      suggestedMessage: "Picked subject\n",
    },
  });

const write = vi.fn<Parameters<typeof ReplayPanel>[0]["write"]>();
const dismiss = vi.fn();
const close = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const show = ({
  kind = "cherryPick",
  busy = false,
  state = { kind: "idle" },
  open = true,
}: {
  kind?: ReplayKind;
  busy?: boolean;
  state?: MergeState;
  open?: boolean;
} = {}) =>
  act(async () =>
    root.render(
      <ReplayPanel
        root={worktree}
        read={{ kind: "ready", value: state }}
        busy={busy}
        write={write}
        abort={vi.fn()}
        dismiss={dismiss}
        review={open ? { kind, commit } : null}
        onCloseReview={close}
        onInspect={vi.fn()}
      />,
    ),
  );
const button = (name: string) => {
  const found = [...host.querySelectorAll("button")].find(
    (item) =>
      (item.textContent?.trim() || item.getAttribute("aria-label")) === name,
  );
  if (!found) throw new Error(`No ${name}`);
  return found;
};
const alerts = () =>
  [...host.querySelectorAll("[role=alert]")].map((item) => item.textContent);
const dialogText = () => host.querySelector("dialog")?.textContent ?? "";
const confirm = (name: string) => act(async () => button(name).click());
const problem = (value: Problem) =>
  ({ kind: "failed", problem: value }) as const;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(repositories.replayReview).mockImplementation((_, of) =>
    Promise.resolve(reviewOf(of.kind)),
  );
  write.mockResolvedValue({ kind: "busy" });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("names the full commit, the destination and the prediction, and confirm carries the review", async () => {
  await show();
  expect(host.querySelector("dialog")?.open).toBe(true);
  expect(repositories.replayReview).toHaveBeenCalledExactlyOnceWith(worktree, {
    kind: "cherryPick",
    commit,
  });
  const text = dialogText();
  expect(text).toContain("Picked subject");
  expect(text).toContain(commit);
  expect(text).toContain("refs/heads/main");
  expect(text).toContain(head);
  expect(text).toContain(CLEAN_PREDICTION);
  write.mockResolvedValue({ kind: "applied", applied: {} as never });
  await confirm("Cherry-pick");
  expect(write).toHaveBeenCalledExactlyOnceWith(worktree, {
    operation: { kind: "replay", review: reviewOf("cherryPick") },
    expect: {
      head: { kind: "attached", reference: "refs/heads/main", oid: head },
    },
  });
  expect(close).toHaveBeenCalledOnce();
  expect(dismiss).not.toHaveBeenCalled();
});

it("reads Revert on the confirm button for a revert", async () => {
  await show({ kind: "revert" });
  expect(button("Revert").disabled).toBe(false);
  expect(dialogText()).toContain("Revert this commit");
});

it("keeps confirm disabled while the review loads", async () => {
  let answer = (_: ReturnType<typeof reviewOf>) => {};
  vi.mocked(repositories.replayReview).mockReturnValue(
    new Promise((resolve) => (answer = resolve)),
  );
  await show();
  expect(button("Cherry-pick").disabled).toBe(true);
  await act(async () => answer(reviewOf("cherryPick")));
  expect(button("Cherry-pick").disabled).toBe(false);
});

it("lists the paths a conflict would touch", async () => {
  vi.mocked(repositories.replayReview).mockResolvedValue(
    reviewOf("cherryPick", { kind: "conflict", paths: ["a.txt", "b/c.txt"] }),
  );
  await show();
  expect(dialogText()).toContain(
    "Will conflict in: a.txt, b/c.txt. You resolve it in the app, then finish or abort.",
  );
  expect(button("Cherry-pick").disabled).toBe(false);
});

it("disables confirm when the changes are already there", async () => {
  vi.mocked(repositories.replayReview).mockResolvedValue(
    reviewOf("revert", { kind: "empty" }),
  );
  await show({ kind: "revert" });
  expect(dialogText()).toContain(
    "These changes are already there, so there is nothing to apply.",
  );
  expect(button("Revert").disabled).toBe(true);
});

it("shows a refusal alone, with confirm disabled and nothing else offered", async () => {
  vi.mocked(repositories.replayReview).mockRejectedValue({
    kind: "conflict",
    message:
      "1234567 is a merge commit, and L1 Git applies only a commit with one parent.",
  });
  await show();
  expect(alerts()).toEqual([
    "1234567 is a merge commit, and L1 Git applies only a commit with one parent.",
  ]);
  expect(button("Cherry-pick").disabled).toBe(true);
  expect(host.querySelector("dl")).toBeNull();
  expect(
    [...host.querySelectorAll("button")].map(
      (item) => item.textContent?.trim() || item.getAttribute("aria-label"),
    ),
  ).toEqual(["Close cherry-pick review", "Cancel", "Cherry-pick"]);
});

it("closes on a plain conflict and shows no failure, because the panel takes over", async () => {
  vi.mocked(repositories.replayReview).mockResolvedValue(
    reviewOf("cherryPick", { kind: "conflict", paths: ["conflict.txt"] }),
  );
  await show();
  write.mockResolvedValue(
    problem({
      kind: "replayStopped",
      message: "The cherry-pick stopped on a conflict, so Git made no commit.",
      output: "",
    }),
  );
  await confirm("Cherry-pick");
  expect(close).toHaveBeenCalledOnce();
  await show({ state: replayState(), open: false });
  expect(host.querySelector("dialog")).toBeNull();
  expect(alerts()).toEqual([]);
  expect(host.textContent).toContain("1 unresolved path");
});

it("closes on a hook or signing stop and the panel shows Git's output until Finish or Abort", async () => {
  await show();
  write.mockResolvedValue(
    problem({
      kind: "replayStopped",
      message:
        "Git refused. The result is staged. Finish or abort the cherry-pick.",
      output: "error: gpg failed to sign the data\n",
    }),
  );
  await confirm("Cherry-pick");
  expect(close).toHaveBeenCalledOnce();
  await show({ state: replayState(), open: false });
  expect(alerts()).toEqual([
    "Git refused. The result is staged. Finish or abort the cherry-pick.error: gpg failed to sign the data\n",
  ]);
  expect(host.querySelector("pre")?.textContent).toBe(
    "error: gpg failed to sign the data\n",
  );
});

it("a clean prediction that hits a conflict still says what happened", async () => {
  await show();
  write.mockResolvedValue(
    problem({
      kind: "replayStopped",
      message: "The cherry-pick stopped on a conflict, so Git made no commit.",
      output: "",
    }),
  );
  await confirm("Cherry-pick");
  await show({ state: replayState(), open: false });
  expect(alerts()).toEqual([
    "The cherry-pick stopped on a conflict, so Git made no commit.",
  ]);
});

it("a stale answer stays open, says to review again, reads again, and replaces the notice", async () => {
  await show();
  vi.mocked(repositories.replayReview).mockResolvedValue(
    reviewOf("cherryPick", { kind: "conflict", paths: ["moved.txt"] }),
  );
  write.mockResolvedValue(
    problem({
      kind: "staleView",
      reason: "headMoved",
      message: "HEAD moved.",
    }),
  );
  await confirm("Cherry-pick");
  expect(close).not.toHaveBeenCalled();
  expect(dismiss).toHaveBeenCalledOnce();
  expect(alerts()).toEqual([
    "What this cherry-pick would do changed since L1 Git showed it, so nothing changed. Review it again.",
  ]);
  expect(repositories.replayReview).toHaveBeenCalledTimes(2);
  expect(dialogText()).toContain("Will conflict in: moved.txt.");
  expect(button("Cherry-pick").disabled).toBe(false);
});

it("a refusal at confirm stays open and says it once when the review now agrees", async () => {
  await show();
  const refused = {
    kind: "conflict",
    message: "notes.txt is staged. Commit or unstage it first.",
  } as const;
  vi.mocked(repositories.replayReview).mockRejectedValue(refused);
  write.mockResolvedValue(problem(refused));
  await confirm("Cherry-pick");
  expect(close).not.toHaveBeenCalled();
  expect(alerts()).toEqual([refused.message]);
  expect(button("Cherry-pick").disabled).toBe(true);
});

it.each(["raced", "afterHookFailed"] as const)(
  "a commit that landed with %s closes and leaves the write notice",
  async (kind) => {
    await show();
    write.mockResolvedValue(
      problem(
        kind === "raced"
          ? { kind, message: "Moved." }
          : { kind, message: "post-commit failed.", output: "" },
      ),
    );
    await confirm("Cherry-pick");
    expect(close).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
  },
);

it("holds every control while a write runs", async () => {
  await show({ busy: true });
  expect(button("Cherry-pick").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  expect(button("Close cherry-pick review").disabled).toBe(true);
  await act(async () => {
    host
      .querySelector("dialog")
      ?.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(close).not.toHaveBeenCalled();
});

it("disables confirm while drafts are frozen", async () => {
  const freeze = freezeDrafts(draftImpact().revision);
  if (freeze.kind !== "frozen") throw new Error(freeze.kind);
  await show();
  expect(button("Cherry-pick").disabled).toBe(true);
  await act(async () => freeze.release());
  expect(button("Cherry-pick").disabled).toBe(false);
});

it("Escape and Cancel close it and write nothing", async () => {
  await show();
  await act(async () => {
    host
      .querySelector("dialog")
      ?.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  await confirm("Cancel");
  expect(close).toHaveBeenCalledTimes(2);
  expect(write).not.toHaveBeenCalled();
});

it("keeps the open review when the operation it started reaches the panel", async () => {
  vi.mocked(repositories.replayReview).mockResolvedValue(
    reviewOf("cherryPick", { kind: "conflict", paths: ["conflict.txt"] }),
  );
  await show();
  expect(dialogText()).toContain("Will conflict in: conflict.txt");

  await show({ state: replayState() });

  expect(repositories.replayReview).toHaveBeenCalledOnce();
  expect(dialogText()).toContain("Will conflict in: conflict.txt");
});
