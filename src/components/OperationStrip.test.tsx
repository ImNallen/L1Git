// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OperationStrip } from "./OperationStrip";
import { inProgress } from "../domain/inProgress";
import { mergeStateSchema } from "../domain/merge";
import type { MergeState } from "../domain/merge";
import { oidSchema } from "../domain/repository";
import type { RepositoryRoot } from "../domain/repository";
import { activeMerge } from "../test/fixtures";

const root = "/fixture/strip" as RepositoryRoot;
let host: HTMLDivElement;
let react: ReturnType<typeof createRoot>;
const onFinish = vi.fn(async () => {});
const onAbort = vi.fn(async () => true);

function merge(conflicted: string[] | null, unresolved: string[]) {
  const state = activeMerge(root, ["a.ts", "b.ts", "c.ts", "clean.ts"]);
  if (state.kind !== "active") throw new Error("expected an active merge");
  state.session.conflicted = conflicted;
  state.unresolved = unresolved;
  state.tree = unresolved.length === 0 ? oidSchema.parse("e".repeat(40)) : null;
  return mergeStateSchema.parse(state);
}

async function render(state: MergeState) {
  const shown = inProgress(state);
  if (shown.kind === "none") throw new Error("nothing in progress");
  await act(async () =>
    react.render(
      <OperationStrip
        shown={shown}
        busy={false}
        onInspect={() => {}}
        onFinish={onFinish}
        onAbort={onAbort}
      />,
    ),
  );
}

const strip = () => host.querySelector("section.operation-strip");
const buttons = () =>
  [...host.querySelectorAll("button")].map((item) => item.textContent?.trim());
function button(name: string) {
  const found = [...host.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No ${name}`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  react = createRoot(host);
});
afterEach(async () => {
  await act(async () => react.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("names both sides by ref and counts what is resolved while conflicts remain", async () => {
  await render(merge(["a.ts", "b.ts", "c.ts"], ["b.ts", "c.ts"]));
  expect(strip()?.classList).toContain("warning");
  expect(
    [...host.querySelectorAll(".side-chip")].map(
      (chip) => `${chip.className}: ${chip.textContent}`,
    ),
  ).toEqual([
    "side-chip incoming: origin/feature",
    "side-chip current: feature",
  ]);
  expect(strip()?.textContent).toContain(
    "2 files still have conflicts. Resolve them, then finish the merge.",
  );
  expect(
    [...host.querySelectorAll(".operation-segments > span")].map(
      (segment) => segment.className,
    ),
  ).toEqual(["done", "", ""]);
  expect(buttons()).toEqual([
    "1 of 3 resolved",
    "Abort merge…",
    "Finish merge",
  ]);
  const finish = button("Finish merge");
  expect(finish.getAttribute("aria-disabled")).toBe("true");
  expect(finish.title).toBe("Resolve every conflicted file first.");
  await act(async () => finish.click());
  expect(onFinish).not.toHaveBeenCalled();
});

it("turns ready once every conflict is resolved and finishes with the suggested message", async () => {
  await render(merge(["a.ts", "b.ts", "c.ts"], []));
  expect(strip()?.classList).toContain("success");
  expect(strip()?.textContent).toContain(
    "All conflicts are resolved. Review the result, then finish.",
  );
  expect(button("3 of 3 resolved")).toBeDefined();
  await act(async () => button("Finish merge").click());
  expect(onFinish).toHaveBeenCalledWith(
    "Merge origin/feature into feature\n",
    expect.objectContaining({ amend: null }),
  );
});

it("counts only what is left for a merge from before conflicts were recorded", async () => {
  await render(merge(null, ["b.ts", "c.ts"]));
  expect(buttons()).toEqual(["2 files left", "Abort merge…", "Finish merge"]);
  expect(host.querySelector(".operation-segments")).toBeNull();
});

it("lists what Abort discards and keeps before it runs", async () => {
  await render(merge(["a.ts", "b.ts", "c.ts"], ["c.ts"]));
  await act(async () => button("Abort merge…").click());
  const dialog = host.querySelector("dialog");
  expect(dialog?.querySelector("h1")?.textContent).toBe("Abort this merge?");
  expect(dialog?.querySelector(".abort-lead")?.textContent).toBe(
    `feature goes back to ${"5".repeat(7)} exactly as before you started.`,
  );
  expect(
    [...(dialog?.querySelectorAll(".discarded li") ?? [])].map(
      (item) => item.textContent,
    ),
  ).toEqual(["a.ts saved resolution", "b.ts saved resolution"]);
  expect(dialog?.querySelector(".kept")?.textContent).toBe(
    "KeptYour commit message draft, untracked files and ignored files.",
  );
  expect(dialog?.textContent).toContain(
    "Unrelated tracked changes block Abort. This cannot be undone.",
  );
  expect(onAbort).not.toHaveBeenCalled();
  await act(async () => button("Abort merge").click());
  expect(onAbort).toHaveBeenCalledOnce();
});

it("says nothing resolved is lost when Abort comes first", async () => {
  await render(merge(["a.ts"], ["a.ts"]));
  await act(async () => button("Abort merge…").click());
  expect(host.querySelector(".discarded li")?.textContent).toBe(
    "Nothing you have resolved yet.",
  );
});

it("offers only the recovery steps for a merge that needs attention", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await render(
    mergeStateSchema.parse({
      kind: "attention",
      session: null,
      reason: "recoveryRequired",
      message: "Preserve the session files.",
    }),
  );
  expect(strip()?.classList).toContain("error");
  expect(buttons()).toEqual(["Copy recovery steps"]);
  await act(async () => button("Copy recovery steps").click());
  expect(writeText).toHaveBeenCalledWith("Preserve the session files.");
  expect(buttons()).toEqual(["Copied"]);
});

it("shows an operation started in a terminal with no progress or actions", async () => {
  await render(
    mergeStateSchema.parse({
      kind: "attention",
      session: null,
      reason: "externalOperation",
      message:
        "Rebase is in progress. Finish or abort it with Git, then refresh.",
    }),
  );
  expect(host.querySelector(".operation-title")?.textContent).toBe(
    "Rebase is in progress",
  );
  expect(strip()?.textContent).toContain(
    "Started outside L1 Git. You can resolve files here, then continue or abort in your terminal.",
  );
  expect(buttons()).toEqual([]);
});

it("keeps the commands Git names for ending a sequence started in a terminal", async () => {
  const commands =
    "Continue it with git cherry-pick --continue or end it with git cherry-pick --abort, then refresh.";
  await render(
    mergeStateSchema.parse({
      kind: "attention",
      session: null,
      reason: "externalOperation",
      message: `A cherry-pick of several commits is in progress. ${commands}`,
    }),
  );
  expect(host.querySelector(".operation-title")?.textContent).toBe(
    "A cherry-pick of several commits is in progress",
  );
  expect(
    [...host.querySelectorAll(".operation-status")].map(
      (line) => line.textContent,
    ),
  ).toEqual([
    "Started outside L1 Git. You can resolve files here, then continue or abort in your terminal.",
    commands,
  ]);
});

it("still opens the inspector from a merge that stopped without conflicts", async () => {
  await render(merge([], []));
  expect(strip()?.textContent).toContain("Review the result, then finish.");
  expect(buttons()).toEqual(["No conflicts", "Abort merge…", "Finish merge"]);
});
