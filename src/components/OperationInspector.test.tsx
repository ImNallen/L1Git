// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  OperationMessage,
  OperationOverview,
  undoNote,
} from "./OperationInspector";
import { clearSubmitted, draftOf, setDraft } from "../commitDrafts";
import { loadMessage } from "../domain/commitMessage";
import { inProgress } from "../domain/inProgress";
import type { MergeState } from "../domain/merge";
import { oidSchema } from "../domain/repository";
import type { RepositoryRoot } from "../domain/repository";
import { activeMerge, replayInProgress } from "../test/fixtures";

vi.mock("../repositories", () => ({ conflictSummary: vi.fn() }));

const root = "/fixture/inspector" as RepositoryRoot;
let host: HTMLDivElement;
let react: ReturnType<typeof createRoot>;

function running(state: MergeState) {
  const shown = inProgress(state);
  if (shown.kind !== "running") throw new Error(`got ${shown.kind}`);
  return shown;
}

const field = (label: string) =>
  host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  );
const hint = () => host.querySelector(".operation-message-hint")?.textContent;

function type(label: string, value: string) {
  const element = field(label);
  if (!element) throw new Error(`No ${label}`);
  const prototype = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  react = createRoot(host);
});
afterEach(async () => {
  await act(async () => react.unmount());
  host.remove();
  clearSubmitted(root, draftOf(root));
  vi.unstubAllGlobals();
});

it("shows the suggested message until the first edit copies it in", async () => {
  const merge = running(activeMerge(root, ["a.ts"]));
  await act(async () => react.render(<OperationMessage running={merge} />));
  expect(hint()).toBe("Suggested");
  expect(field("Merge commit message")?.value).toBe("");
  expect(field("Merge commit message")?.getAttribute("placeholder")).toBe(
    "Merge origin/feature into feature",
  );
  await act(async () => type("Merge description", "Keeps both retries."));
  expect(draftOf(root).draft).toEqual({
    summary: "Merge origin/feature into feature",
    description: "Keeps both retries.",
  });
  expect(hint()).toBe("Edited · Use suggested");
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".operation-message-hint")?.click(),
  );
  expect(draftOf(root).draft).toEqual({ summary: "", description: "" });
  expect(hint()).toBe("Suggested");
});

it("makes the user turn off a saved Amend before writing a replay's message", async () => {
  const loaded = loadMessage("Previous commit\n");
  setDraft(root, {
    draft: loaded.draft,
    amend: {
      draftAside: { summary: "unsent draft", description: "" },
      loaded,
      head: oidSchema.parse("4".repeat(40)),
    },
  });
  const pick = running(replayInProgress(root, ["a.ts"]));
  await act(async () => react.render(<OperationMessage running={pick} />));
  expect(host.textContent).toContain("Amend is on for this worktree.");
  expect(host.querySelector("textarea")).toBeNull();
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Turn off Amend")
      ?.click(),
  );
  expect(draftOf(root).amend).toBeNull();
  expect(field("Summary")?.value).toBe("unsent draft");
});

it("explains what Finish does with each side", async () => {
  await act(async () =>
    react.render(
      <OperationOverview running={running(activeMerge(root, ["a.ts"]))} />,
    ),
  );
  expect(host.querySelector(".operation-sides")?.textContent).toBe(
    `Intofeature${"5".repeat(7)}Fromorigin/feature${"6".repeat(7)}`,
  );
  expect(host.querySelector(".operation-overview p")?.textContent).toBe(
    "The merge commit gets both as parents. feature moves only when you finish.",
  );
  await act(async () =>
    react.render(
      <OperationOverview
        running={running(replayInProgress(root, ["a.ts"], { kind: "revert" }))}
      />,
    ),
  );
  expect(host.querySelector(".operation-overview p")?.textContent).toBe(
    "Finish adds one commit that undoes “Picked commit”. main moves only when you finish.",
  );
});

it("says which steps Undo covers for each operation", () => {
  expect(undoNote(running(activeMerge(root, ["a.ts"])))).toBe(
    "Each resolution has Undo until you finish. Finish and Abort cannot be undone.",
  );
  expect(undoNote(running(replayInProgress(root, ["a.ts"])))).toBe(
    "Each resolution has Undo until you finish. Finish can be undone like a commit, which does not reopen the conflict. Abort cannot be undone.",
  );
  expect(
    undoNote(running(replayInProgress(root, ["a.ts"], { empty: true }))),
  ).toBe("Each resolution has Undo until you abort. Abort cannot be undone.");
});
