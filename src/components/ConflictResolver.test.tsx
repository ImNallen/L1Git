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
  wholeFileConflict: vi.fn(async () => null),
  mac: true,
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
const clean = conflictSnapshotSchema.parse({
  ...snapshot,
  version: "d".repeat(40),
  working: "before\r\nours\r\nafter",
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
  abortReplay: async () => ({ kind: "busy" }),
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
function cardButton(name: string, ordinal = 0) {
  const card = host.querySelectorAll(".conflict-card")[ordinal];
  const found = [...(card?.querySelectorAll("button") ?? [])].find((item) =>
    item.textContent?.startsWith(name),
  );
  if (!found) throw new Error(`Missing ${name} in card ${ordinal}`);
  return found;
}
function counter() {
  return host.querySelector(".conflict-counter")?.textContent;
}
function press(key: string, target: Element, init: KeyboardEventInit = {}) {
  return act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        composed: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}
function resolverRoot() {
  const found = host.querySelector(".conflict-resolver");
  if (!found) throw new Error("Missing resolver");
  return found;
}
function menuItem(name: string) {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === name);
  if (!found) throw new Error(`Missing menu item ${name}`);
  return found;
}
async function use(next: typeof snapshot, refresh: number) {
  vi.mocked(repositories.conflictFile).mockResolvedValue({
    kind: "editable",
    snapshot: next,
  });
  await render(refresh);
  await vi.waitFor(() =>
    expect(resolutionOf(key)?.snapshot.version).toBe(next.version),
  );
  await render(refresh);
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
        leading={<button>History</button>}
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

it("shows all source versions, chooses from a conflict card, saves, and separately marks resolved", async () => {
  for (const [tab, text] of [
    ["Base", "base"],
    ["Current", "ours"],
    ["Incoming", "theirs"],
  ]) {
    if (!tab) throw new Error("Missing tab");
    await act(async () => button(tab).click());
    expect(shadows()[0]?.textContent).toContain(text);
  }
  await act(async () => cardButton("Current").click());
  await vi.waitFor(() => {
    const result = host.querySelector(".conflict-code diffs-container");
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
  await use(clean, 10);
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

const replay = (kind: "cherryPick" | "revert", footprint: string[]) =>
  mergeStateSchema.parse({
    kind: "replay",
    progress: {
      root: snapshot.root,
      kind,
      commit: "a".repeat(40),
      subject: "Picked",
      destination: {
        kind: "attached",
        reference: "refs/heads/main",
        oid: "b".repeat(40),
      },
      footprint,
      conflicted: [snapshot.path],
      unresolved: [snapshot.path],
      staged: "c".repeat(40),
      tree: null,
      empty: false,
      suggestedMessage: "Picked\n",
    },
  });

it.each([
  ["cherryPick", "outside the cherry-pick's affected paths"],
  ["revert", "outside the revert's affected paths"],
] as const)(
  "names a %s when a path is outside its footprint",
  async (kind, text) => {
    vi.mocked(repositories.mergeState).mockResolvedValue(
      replay(kind, ["another.txt"]),
    );
    await render(1);
    expect(button("Mark resolved").disabled).toBe(true);
    expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain("the merge's");
  },
);

it("lets the resolver work inside a replay's footprint, and says what Incoming holds in a revert", async () => {
  await use(clean, 10);
  vi.mocked(repositories.mergeState).mockResolvedValue(
    replay("cherryPick", [snapshot.path]),
  );
  await render(1);
  expect(button("Mark resolved").disabled).toBe(false);
  expect(host.textContent).not.toContain("the reverse of the commit");
  vi.mocked(repositories.mergeState).mockResolvedValue(
    replay("revert", [snapshot.path]),
  );
  await render(2);
  expect(button("Mark resolved").disabled).toBe(false);
  expect(host.textContent).toContain(
    "Incoming holds the reverse of the commit",
  );
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
      conflicted: ["another.txt"],
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

const region = (name: string) => [
  "<<<<<<< HEAD",
  `${name} ours`,
  "=======",
  `${name} theirs`,
  ">>>>>>> topic",
];
const pairText = (first: string[], second: string[]) =>
  ["a", ...first, "b", ...second, "c"].join("\n");
const pair = conflictSnapshotSchema.parse({
  ...snapshot,
  version: "e".repeat(40),
  working: pairText(region("one"), region("two")),
});
const merging = (footprint: string[]) =>
  mergeStateSchema.parse({
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
      footprint,
      conflicted: footprint,
      suggestedMessage: "Merge upstream",
    },
    unresolved: footprint,
    staged: "c".repeat(40),
    tree: null,
    sourceMoved: false,
  });

it("names each card's sides by ref, and falls back to Current and Incoming outside an operation", async () => {
  await use(pair, 10);
  const chips = () =>
    [...host.querySelectorAll(".conflict-card .side-chip")].map(
      (chip) => `${chip.className}: ${chip.textContent}`,
    );
  expect(chips()).toEqual([
    "side-chip current: Current",
    "side-chip incoming: Incoming",
    "side-chip current: Current",
    "side-chip incoming: Incoming",
  ]);
  vi.mocked(repositories.mergeState).mockResolvedValue(
    merging([snapshot.path]),
  );
  await render(11);
  await vi.waitFor(() =>
    expect(chips().slice(0, 2)).toEqual([
      "side-chip current: main",
      "side-chip incoming: origin/main",
    ]),
  );
  const cards = [...host.querySelectorAll(".conflict-card")];
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
    "Conflict 1 of 2",
    "Conflict 2 of 2",
  ]);
  expect(cards[0]?.textContent).not.toMatch(/ours|theirs/i);
  expect(
    [...(cards[0]?.querySelectorAll("button") ?? [])].map((item) => [
      item.textContent,
      item.getAttribute("aria-keyshortcuts"),
    ]),
  ).toEqual([
    ["Current1", "1"],
    ["Incoming2", "2"],
    ["Both3", "3"],
    ["Edit resultE", "E"],
  ]);
});

it("counts conflicts left in the draft and moves between them with J and K", async () => {
  await use(pair, 10);
  const focused = () =>
    [...host.querySelectorAll(".conflict-card")].map((card) =>
      card.hasAttribute("data-focused"),
    );
  expect(counter()).toBe("Conflict 1 of 2");
  expect(focused()).toEqual([true, false]);
  expect(button("Previous").disabled).toBe(true);
  await press("j", resolverRoot());
  expect(counter()).toBe("Conflict 2 of 2");
  expect(focused()).toEqual([false, true]);
  expect(button("Next").disabled).toBe(true);
  await press("j", resolverRoot());
  expect(counter()).toBe("Conflict 2 of 2");
  await press("k", resolverRoot());
  expect(counter()).toBe("Conflict 1 of 2");
  await act(async () => button("Next").click());
  expect(counter()).toBe("Conflict 2 of 2");
  await act(async () => cardButton("Incoming", 1).click());
  expect(resolutionOf(key)?.text).toBe(pairText(region("one"), ["two theirs"]));
  expect(counter()).toBe("Conflict 1 of 1");
  await press("1", resolverRoot());
  expect(resolutionOf(key)?.text).toBe(pairText(["one ours"], ["two theirs"]));
  expect(counter()).toBe("No conflicts left");
  expect(host.querySelectorAll(".conflict-card")).toHaveLength(0);
});

it.each([
  ["1", "Current", ["one ours"]],
  ["2", "Incoming", ["one theirs"]],
  ["3", "Both", ["one ours", "one theirs"]],
])(
  "chooses the focused conflict with %s exactly as its %s button does",
  async (key_, label, kept) => {
    const expected = pairText(kept, region("two"));
    await use(pair, 10);
    await press(key_, resolverRoot());
    expect(resolutionOf(key)?.text).toBe(expected);
    const draft = resolutionOf(key);
    if (!draft) throw new Error("Missing resolution draft");
    await act(async () => reloadResolution(key, draft.revision));
    await render(11);
    expect(resolutionOf(key)?.text).toBe(pair.working);
    await act(async () => cardButton(label).click());
    expect(resolutionOf(key)?.text).toBe(expected);
  },
);

it("keeps shortcuts out of text inputs, the editor, modified keys and other surfaces", async () => {
  await use(pair, 10);
  const input = document.createElement("input");
  resolverRoot().querySelector(".conflict-hint")?.append(input);
  await press("1", input);
  await press("j", input);
  input.remove();
  await press("1", resolverRoot(), { metaKey: true });
  await press("1", resolverRoot(), { ctrlKey: true });
  await press("1", document.body);
  expect(resolutionOf(key)?.text).toBe(pair.working);
  expect(counter()).toBe("Conflict 1 of 2");
  await press("e", resolverRoot());
  expect(button("Edit").getAttribute("aria-pressed")).toBe("true");
  const textbox = shadows().flatMap((shadow) => [
    ...shadow.querySelectorAll<HTMLElement>('[role="textbox"]'),
  ])[0];
  if (!textbox) throw new Error("Missing Pierre textbox");
  await press("2", textbox);
  await press("k", textbox);
  expect(resolutionOf(key)?.text).toBe(pair.working);
  expect(button("Edit").getAttribute("aria-pressed")).toBe("true");
});

it("shows save state in the header and why Mark resolved is unavailable", async () => {
  const status = () =>
    host.querySelector(".conflict-save-status")?.textContent ?? null;
  expect(status()).toBeNull();
  expect(button("Save result").className).toContain("secondary");
  expect(button("Save result").disabled).toBe(true);
  expect(button("Mark resolved").disabled).toBe(true);
  expect(button("Mark resolved").title).toBe("Resolve every conflict first.");
  await act(async () => cardButton("Current").click());
  expect(status()).toBe("Unsaved changes");
  expect(button("Save result").className).toContain("primary");
  expect(button("Save result").disabled).toBe(false);
  expect(button("Mark resolved").title).toBe("Save the result first.");
  write.mockImplementationOnce(async () => {
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
  expect(status()).toBe("Saved");
  expect(button("Save result").className).toContain("secondary");
  expect(button("Mark resolved").disabled).toBe(false);
  expect(button("Mark resolved").title).toBe("Stage the saved result");
});

it("refuses Mark resolved while a saved result keeps stray conflict markers", async () => {
  await use(
    conflictSnapshotSchema.parse({
      ...snapshot,
      version: "c".repeat(40),
      working:
        "before\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> incoming\r\nafter",
    }),
    1,
  );
  expect(counter()).toBe("Leftover markers");
  expect(button("Mark resolved").disabled).toBe(true);
  expect(button("Mark resolved").title).toBe(
    "Remove the leftover conflict markers first.",
  );
  await act(async () => button("Mark resolved").click());
  expect(write).not.toHaveBeenCalled();
});

it("keeps Copy result, Reload from disk and Refresh conflict in the More menu", async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const more = button("");
  expect(more.getAttribute("aria-label")).toBe("More actions");
  await act(async () => more.click());
  const menu = document.querySelector('[role="menu"]');
  expect(menu?.getAttribute("aria-label")).toBe("More actions");
  expect(
    [...(menu?.children ?? [])].map(
      (item) => item.getAttribute("role") + ":" + item.textContent,
    ),
  ).toEqual([
    "menuitem:Copy result",
    "menuitem:Reload from disk…",
    "separator:",
    "menuitem:Refresh conflict",
  ]);
  writeText.mockResolvedValueOnce();
  await act(async () => menuItem("Copy result").click());
  expect(writeText).toHaveBeenCalledWith(snapshot.working);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  writeText.mockRejectedValueOnce(new Error("denied"));
  await act(async () => more.click());
  await act(async () => menuItem("Copy result").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not copy the result",
  );

  const reads = vi.mocked(repositories.conflictFile).mock.calls.length;
  await act(async () => more.click());
  await act(async () => menuItem("Refresh conflict").click());
  expect(vi.mocked(repositories.conflictFile).mock.calls.length).toBe(
    reads + 1,
  );

  await act(async () => cardButton("Incoming").click());
  expect(resolutionOf(key)?.text).toContain("theirs");
  await act(async () => more.click());
  await act(async () => menuItem("Reload from disk…").click());
  expect(host.ownerDocument.body.textContent).toContain(
    "Discard this result draft?",
  );
  await act(async () => {
    [...document.querySelectorAll("button")]
      .find((item) => item.textContent === "Discard draft and reload")
      ?.click();
  });
  await vi.waitFor(() =>
    expect(resolutionOf(key)?.text).toBe(snapshot.working),
  );
});
