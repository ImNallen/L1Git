// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as repositories from "../repositories";
import { conflictSnapshotSchema, appliedSchema } from "../domain/repository";
import { ConflictResolver } from "./ConflictResolver";
import { mergeStateSchema } from "../domain/merge";
import { draftImpact } from "../draftProtection";
import {
  chooseResolution,
  reloadResolution,
  resolutionKey,
  resolutionOf,
} from "../resolutionDrafts";
import type { WritesView } from "../useWrites";

vi.mock("../repositories", () => ({
  conflictFile: vi.fn(),
  mergeState: vi.fn(),
}));
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  }),
});

const snapshot = conflictSnapshotSchema.parse({
  root: "/work/component",
  path: "f.txt",
  head: { kind: "detached", oid: "a".repeat(40) },
  entry: {
    kind: "unmerged",
    path: "f.txt",
    conflict: "bothModified",
    submodule: null,
    stages: Object.fromEntries(
      ["base", "ours", "theirs"].map((key) => [
        key,
        { mode: "100644", oid: "a".repeat(40) },
      ]),
    ),
  },
  version: "b".repeat(40),
  base: "base\r\n",
  current: "ours\r\n",
  incoming: "theirs\r\n",
  working:
    "before\r\n<<<<<<< current\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> incoming\r\nafter",
});
const key = resolutionKey(snapshot.root, snapshot.path);
const applied = appliedSchema.parse({
  id: "a".repeat(16),
  root: snapshot.root,
  operation: {
    kind: "saveConflict",
    path: snapshot.path,
    version: snapshot.version,
  },
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const write = vi.fn<WritesView["write"]>();
const resolved = vi.fn();
const writes: WritesView = {
  history: { kind: "unread" },
  running: null,
  notice: null,
  write,
  undo: async () => ({ kind: "busy" }),
  redo: async () => ({ kind: "busy" }),
  merge: async () => ({ kind: "busy" }),
  dismiss: () => {},
  rereadHistory: () => {},
};
function button(name: string) {
  const found = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
function shadows() {
  return [...host.querySelectorAll("diffs-container")].flatMap((item) =>
    item.shadowRoot ? [item.shadowRoot] : [],
  );
}
async function render(refresh = 0) {
  await act(async () =>
    root.render(
      <ConflictResolver
        root={snapshot.root}
        path={snapshot.path}
        refresh={refresh}
        theme="dark"
        painted={false}
        writes={writes}
        onResolved={resolved}
      />,
    ),
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(repositories.mergeState).mockResolvedValue({ kind: "idle" });
  vi.mocked(repositories.conflictFile).mockResolvedValue({
    kind: "editable",
    snapshot,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.mocked(repositories.conflictFile).mockResolvedValue({
    kind: "external",
    root: snapshot.root,
    path: snapshot.path,
    reason: "structural",
  });
  const draft = resolutionOf(key);
  if (draft) await reloadResolution(key, draft.revision);
  expect(draftImpact().tasks).toBe(0);
  vi.unstubAllGlobals();
});

it("shows all source versions, uses Pierre choices, saves, and separately marks resolved", async () => {
  for (const [tab, text] of [
    ["Base", "base"],
    ["Current", "ours"],
    ["Incoming", "theirs"],
  ]) {
    if (!tab) throw new Error("Missing tab");
    await act(async () => button(tab).click());
    expect(shadows()[0]?.textContent).toContain(text);
  }
  const choice = shadows()
    .flatMap((shadow) => [...shadow.querySelectorAll("button")])
    .find((item) => item.textContent?.toLowerCase().includes("accept current"));
  if (!choice) throw new Error("Missing Pierre choice");
  await act(async () => choice.click());
  await vi.waitFor(() => {
    const result = host.querySelector(".conflict-result diffs-container");
    expect(result?.shadowRoot?.textContent).toContain("ours");
    expect(result?.shadowRoot?.textContent).toContain("after");
  });
  expect(button("Mark resolved").disabled).toBe(true);
  write.mockImplementationOnce(async (_root, request) => {
    expect(request.operation).toMatchObject({
      kind: "saveConflict",
      text: "before\r\nours\r\nafter",
    });
    vi.mocked(repositories.conflictFile).mockResolvedValue({
      kind: "editable",
      snapshot: conflictSnapshotSchema.parse({
        ...snapshot,
        version: "c".repeat(40),
        working: "before\r\nours\r\nafter",
      }),
    });
    return { kind: "applied", applied };
  });
  await act(async () => button("Save result").click());
  expect(button("Save result").disabled).toBe(true);
  expect(button("Mark resolved").disabled).toBe(false);
  write.mockResolvedValueOnce({ kind: "applied", applied });
  await act(async () => button("Mark resolved").click());
  expect(write.mock.calls[1]?.[1].operation.kind).toBe("stageFiles");
  expect(resolved).toHaveBeenCalledOnce();
});

it("retains typed text through refresh, editor Undo, unmount and reopen", async () => {
  await act(async () => button("Edit").click());
  const textbox = shadows().flatMap((shadow) => [
    ...shadow.querySelectorAll<HTMLElement>('[role="textbox"]'),
  ])[0];
  if (!textbox) throw new Error("Missing Pierre textbox");
  await act(async () => {
    textbox.focus();
    textbox.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    textbox.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "X",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  });
  expect(resolutionOf(key)?.text).toContain("X");
  const typed = resolutionOf(key)?.text;
  await render(1);
  expect(resolutionOf(key)?.text).toBe(typed);
  await act(async () => {
    textbox.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  });
  expect(write).not.toHaveBeenCalled();
  expect(resolutionOf(key)?.text).toBe(snapshot.working);
  await act(async () => {
    textbox.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "Y",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  });
  const kept = resolutionOf(key)?.text;
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(2);
  await act(async () => button("Edit").click());
  expect(resolutionOf(key)?.text).toBe(kept);
});

it("keeps recovery read-only while preserving resolution for an external operation", async () => {
  vi.mocked(repositories.mergeState).mockResolvedValue({
    kind: "attention",
    session: null,
    reason: "recoveryRequired",
    message: "Preserve the corrupt session record.",
  });
  await render(1);
  expect(button("Mark resolved").disabled).toBe(true);
  expect(host.textContent).toContain("Preserve the corrupt session");
  vi.mocked(repositories.mergeState).mockResolvedValue({
    kind: "attention",
    session: null,
    reason: "externalOperation",
    message: "Finish the external operation with Git.",
  });
  await render(2);
  expect(button("Mark resolved").disabled).toBe(false);
});

it("blocks Save and Mark outside a managed merge's footprint without losing draft text", async () => {
  const state = mergeStateSchema.parse({
    kind: "active",
    session: {
      id: "a".repeat(16),
      review: {
        root: snapshot.root,
        destination: { reference: "refs/heads/main", oid: "a".repeat(40) },
        source: { reference: "refs/remotes/origin/main", oid: "b".repeat(40) },
        plan: "mergeCommit",
        context: {
          kind: "upstream",
          tracking: { remote: "origin", merge: "refs/heads/main", fetch: [] },
        },
      },
      footprint: ["another.txt"],
      suggestedMessage: "Merge upstream",
    },
    unresolved: [snapshot.path],
    staged: "c".repeat(40),
    tree: null,
    sourceMoved: false,
  });
  vi.mocked(repositories.mergeState).mockResolvedValue(state);
  await render(1);
  expect(button("Mark resolved").disabled).toBe(true);
  expect(host.textContent).toContain("outside the merge's affected paths");
  const draft = resolutionOf(key);
  if (!draft) throw new Error("Missing resolution draft");
  await act(async () =>
    chooseResolution(key, draft.editorEpoch, "keep this resolution"),
  );
  expect(button("Save result").disabled).toBe(true);
  await act(async () => button("Save result").click());
  expect(write).not.toHaveBeenCalled();
  expect(resolutionOf(key)?.text).toBe("keep this resolution");
});
