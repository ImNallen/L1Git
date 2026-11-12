// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as repositories from "../repositories";
import {
  appliedSchema,
  problemFrom,
  wholeFileConflictSchema,
} from "../domain/repository";
import type { RepositoryRoot } from "../domain/repository";
import { activeMerge, replayInProgress } from "../test/fixtures";
import type { WritesView } from "../useWrites";
import { ConflictResolver } from "./ConflictResolver";

vi.mock("../repositories", () => ({
  conflictFile: vi.fn(),
  mergeState: vi.fn(),
  wholeFileConflict: vi.fn(),
  mac: true,
}));
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  }),
});

const workspace = "/work/whole" as RepositoryRoot;
const path = "src/sync/legacy-retry.ts";
const head = { kind: "detached", oid: "a".repeat(40) } as const;
const deleted = wholeFileConflictSchema.unwrap().parse({
  head,
  version: "b".repeat(40),
  shape: "deletedByThem",
  base: "a\nb\n",
  current: { mode: "100644", size: 8, text: "a\nb\nc\nd\n" },
  incoming: null,
  disk: "matchesCurrent",
});
const applied = appliedSchema.parse({
  id: "a".repeat(16),
  root: workspace,
  operation: {
    kind: "resolveWhole",
    path,
    version: "b".repeat(40),
    keep: "incoming",
  },
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const write = vi.fn<WritesView["write"]>();
const resolved = vi.fn();
const idleWrites: WritesView = {
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

async function render(refresh = 0, writes = idleWrites) {
  await act(async () =>
    root.render(
      <ConflictResolver
        root={workspace}
        path={path}
        refresh={refresh}
        theme="dark"
        painted={false}
        writes={writes}
        onResolved={resolved}
        leading={<button>History</button>}
      />,
    ),
  );
  await vi.waitFor(() =>
    expect(host.querySelector('[role="status"], .whole-choice')).not.toBe(null),
  );
}
function button(name: string) {
  const found = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
function press(key: string) {
  const target = button("History");
  return act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(repositories.mergeState).mockResolvedValue(
    activeMerge(workspace, [path]),
  );
  vi.mocked(repositories.conflictFile).mockResolvedValue({
    kind: "external",
    root: workspace,
    path,
    reason: "structural",
  });
  vi.mocked(repositories.wholeFileConflict).mockResolvedValue(deleted);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("offers both outcomes of a deleted-vs-edited file, named by ref, with the kept side's changes as a diff", async () => {
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Keep file"));
  const header = host.querySelector(".conflict-header")?.textContent;
  expect(header).toContain("legacy-retry.ts");
  expect(header).toContain("src/sync");
  expect(header).toContain("Deleted vs edited");
  expect(header).toContain("Choosing resolves the file. ⌘Z undoes it.");
  expect(header).not.toContain("Mark resolved");
  expect(host.querySelector(".whole-choice-lead")?.textContent).toBe(
    "origin/feature deleted it. feature changed 2 lines in it. There are no lines to merge, so pick one outcome.",
  );
  const cards = [...host.querySelectorAll(".whole-card")];
  expect(cards.map((card) => card.querySelector("h3")?.textContent)).toEqual([
    "Keep the file with your changes",
    "Delete the file",
  ]);
  expect(cards[0]?.textContent).toContain("Matches what’s on disk");
  expect(cards[0]?.querySelector("diffs-container")).not.toBe(null);
  expect(cards[1]?.textContent).toContain("legacy-retry.ts (4 lines)");
  expect(host.textContent).not.toContain("Resolve it outside L1 Git");
});

it.each([
  ["1", "current"],
  ["2", "incoming"],
] as const)(
  "resolves with key %s by keeping %s at the version it read, then leaves",
  async (key, keep) => {
    write.mockResolvedValueOnce({ kind: "applied", applied });
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("Keep file"));
    await press(key);
    expect(write).toHaveBeenCalledExactlyOnceWith(workspace, {
      expect: { head },
      operation: { kind: "resolveWhole", path, version: deleted.version, keep },
    });
    expect(resolved).toHaveBeenCalledOnce();
  },
);

it("shows a stale version's problem and re-reads the conflict on Refresh", async () => {
  write.mockResolvedValueOnce({
    kind: "failed",
    problem: problemFrom({
      kind: "staleView",
      reason: "pathChanged",
      message: `${path} changed since L1 Git read it. Refresh and try again.`,
    }),
  });
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Delete file"));
  await act(async () => button("Delete file").click());
  expect(resolved).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "changed since L1 Git read it",
  );
  const reads = vi.mocked(repositories.wholeFileConflict).mock.calls.length;
  await act(async () => button("Refresh conflict").click());
  await vi.waitFor(() =>
    expect(vi.mocked(repositories.wholeFileConflict).mock.calls.length).toBe(
      reads + 1,
    ),
  );
});

it("disables both choices with a reason while another write runs", async () => {
  await render(0, {
    ...idleWrites,
    running: { action: "write", label: "Stage" },
  });
  await vi.waitFor(() => expect(host.textContent).toContain("Keep file"));
  for (const name of ["Keep file", "Delete file"]) {
    expect(button(name).disabled).toBe(true);
    expect(button(name).title).toBe(
      "Wait for the current operation to finish.",
    );
  }
  await press("1");
  expect(write).not.toHaveBeenCalled();
});

it("refuses a path outside the operation's footprint, and names a replay's incoming commit", async () => {
  vi.mocked(repositories.mergeState).mockResolvedValue(
    replayInProgress(workspace, ["another.txt"]),
  );
  await render();
  await vi.waitFor(() =>
    expect(host.textContent).toContain(
      "outside the cherry-pick's affected paths",
    ),
  );
  expect(button("Keep file").disabled).toBe(true);
  expect(host.querySelector(".whole-choice-lead")?.textContent).toMatch(
    /^[0-9a-f]{7} deleted it\./,
  );
});

it("keeps the outside-L1-Git message for a conflict that is not whole-file", async () => {
  vi.mocked(repositories.wholeFileConflict).mockResolvedValue(null);
  vi.mocked(repositories.conflictFile).mockResolvedValue({
    kind: "external",
    root: workspace,
    path,
    reason: "encoding",
  });
  await render();
  await vi.waitFor(() =>
    expect(host.textContent).toContain(
      "Resolve it outside L1 Git, then refresh and mark it resolved.",
    ),
  );
  expect(host.querySelector(".whole-choice")).toBe(null);
});
