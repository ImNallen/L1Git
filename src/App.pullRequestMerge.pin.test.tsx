// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { PullRequest } from "./domain/pullRequest";
import { oidSchema } from "./domain/repository";
import {
  focused,
  get,
  installHarness,
  query,
  queryAll,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import type { World } from "./test/fakeBridge";
import { PIN } from "./test/fixtures";
import { holding } from "./test/pullRequestCheckouts";
import { open, page, pull, tab, visit } from "./test/pullRequests";

installHarness();

const HEAD = "1".repeat(40);
const box = () => get("region", "Merging");
const said = () => box().querySelector(".merge-said")?.textContent;
const announced = () =>
  box().querySelector("[role='status']")?.textContent?.trim();
const boxButtons = () =>
  queryAll("button", undefined, box()).map((button) => button.textContent);
const popover = () => get("dialog", /^Merge #1 into main$/);
const field = (name: string | RegExp) =>
  get("textbox", name, popover()) as HTMLInputElement;
const choice = (name: string | RegExp) =>
  get("checkbox", name, popover()) as HTMLInputElement;
const method = (value: string) =>
  popover().querySelector<HTMLInputElement>(`input[value='${value}']`)!;
const sent = (app: Harness) => app.bridge.world.host.mutations;
const kinds = (app: Harness) => sent(app).map(({ kind }) => kind);

function change(world: World, number: number, fields: Partial<PullRequest>) {
  const key = pullKey("octo/pin", number);
  const was = world.host.details.get(key)!;
  world.host.details.set(key, { ...was, ...fields });
}
const changed =
  (fields: Partial<PullRequest>, number = 1) =>
  (world: World) =>
    change(world, number, fields);

async function confirm(app: Harness, label = "Squash and merge") {
  await app.click(get("button", label, popover()));
}

it("merges once with the method, message and head the popover showed, then deletes the branch it was asked to", async () => {
  const app = await visit();
  await open(app, 1);
  expect(said()).toBe("Ready to mergeGitHub finds nothing that stops it.");
  await app.click(get("button", "Squash and merge"));
  expect(popover().textContent).toContain("1 commit");
  expect(method("squash").checked).toBe(true);
  expect(field("Commit on main").value).toBe("Row 1 (#1)");
  expect(field("Commit message").value).toBe("Reads **once**.");
  expect(popover().textContent).toContain("Merging has no Undo.");
  const remote = choice(/^Delete branch-1 on GitHub/);
  expect(remote.checked, "the repository doesn't delete it itself").toBe(false);
  expect(
    query("checkbox", /^Delete the local branch too/, popover()),
    "no local branch tracks it",
  ).toBeNull();
  await app.click(remote);
  await app.type(field("Commit message"), "Reads once.");
  await confirm(app);

  await vi.waitFor(() =>
    expect(kinds(app)).toEqual(["merge", "deleteHeadBranch"]),
  );
  expect(sent(app)).toEqual([
    {
      kind: "merge",
      pull: "PR_1",
      expectedHead: HEAD,
      method: "squash",
      headline: "Row 1 (#1)",
      body: "Reads once.",
    },
    {
      kind: "deleteHeadBranch",
      pull: "PR_1",
      branch: "branch-1",
      expectedHead: HEAD,
    },
  ]);
  await vi.waitFor(() =>
    expect(said()).toBe(
      "Merged into mainMerged as 9999999 just now. branch-1 was deleted on GitHub.",
    ),
  );
  expect(focused(), "focus stays in the box the merge started from").toBe(
    "region Merging",
  );
  expect(query("dialog", /^Merge #1/)).toBeNull();
  expect(boxButtons()).toEqual([]);
});

it("sends nothing until the user confirms, and nothing after Cancel", async () => {
  const app = await visit();
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  await app.click(get("button", "Cancel", popover()));
  expect(query("dialog", /^Merge #1/)).toBeNull();
  await app.click(get("button", "Squash and merge"));
  await app.press("Enter", { target: method("merge") });
  expect(query("dialog", /^Merge #1/), "Enter doesn't merge").not.toBeNull();
  await app.press("Enter", { target: field("Commit message"), metaKey: true });
  await vi.waitFor(() => expect(kinds(app)).toEqual(["merge"]));
});

it("refuses a merge whose head moved while the user confirmed, and leads to the new commits", async () => {
  const app = await visit();
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  // Someone pushes after the popover opened, before L1 Git reads it again.
  change(app.bridge.world, 1, {
    head: { ...pull(1).head, oid: oidSchema.parse("2".repeat(40)) },
  });
  await confirm(app);

  await vi.waitFor(() =>
    expect(said()).toBe(
      "GitHub didn't merge thisNew commits arrived. Review them, then merge.",
    ),
  );
  expect(announced()).toBe("GitHub didn't merge this");
  expect(kinds(app), "it reached GitHub once, and nothing followed").toEqual([
    "merge",
  ]);
  expect(sent(app)[0]).toMatchObject({ expectedHead: HEAD });
  expect(
    app.bridge.world.host.details.get(pullKey("octo/pin", 1))?.state,
  ).toEqual({ kind: "open", draft: false });
  await app.click(get("button", "Review and try again"));
  expect(tab("Commits").getAttribute("aria-selected")).toBe("true");
  expect(said()).toBe("Ready to mergeGitHub finds nothing that stops it.");
  expect(boxButtons()).toEqual(["Squash and merge", ""]);
});

it("tells a moved head before sending, when L1 Git has read it", async () => {
  const app = await visit();
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  change(app.bridge.world, 1, {
    head: { ...pull(1).head, oid: oidSchema.parse("2".repeat(40)) },
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  await app.refocusWindow();
  now.mockRestore();
  await app.settle();
  await confirm(app);
  expect(get("alert", undefined, popover()).textContent).toBe(
    "New commits arrived. Review them, then merge.",
  );
  expect(kinds(app)).toEqual([]);
});

it("says plainly that a merge got no answer, and deletes nothing even once a read finds it merged", async () => {
  const app = await visit({
    world: (world) =>
      void world.host.writes.push({ kind: "unknown", applied: true }),
  });
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  await app.click(choice(/^Delete branch-1 on GitHub/));
  const reading = app.bridge.hold("pullRequest");
  const looking = app.bridge.hold("check");
  await confirm(app);
  await Promise.all([reading.arrived, looking.arrived]);
  await vi.waitFor(() =>
    expect(said()).toBe(
      "L1 Git can't tell yet whether this mergedL1 Git sent the merge to GitHub and got no answer, so it may have merged. L1 Git looks again each time it reads this pull request.",
    ),
  );
  expect(boxButtons(), "nothing to send again").toEqual([]);
  expect(get("link", "Open on GitHub", box()).getAttribute("href")).toBe(
    "https://github.com/octo/pin/pull/1",
  );
  looking.release();
  reading.release();
  await vi.waitFor(() => expect(said()).toMatch(/^Merged into main/));
  await app.settle();
  expect(kinds(app)).toEqual(["merge"]);
});

it("offers the branch delete that a merge with no answer skipped, and sends it only on a click", async () => {
  const app = await visit({
    world: (world) =>
      void world.host.writes.push({ kind: "unknown", applied: true }),
  });
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  await app.click(choice(/^Delete branch-1 on GitHub/));
  await confirm(app);
  await vi.waitFor(() =>
    expect(said()).toBe(
      "Merged into mainMerged as 9999999 just now. L1 Git got no answer to the merge, so it didn't delete branch-1 on GitHub.",
    ),
  );
  expect(kinds(app), "nothing is deleted without a click").toEqual(["merge"]);

  await app.click(get("button", "Delete branch-1 on GitHub", box()));
  await vi.waitFor(() =>
    expect(kinds(app)).toEqual(["merge", "deleteHeadBranch"]),
  );
  expect(sent(app)[1]).toEqual({
    kind: "deleteHeadBranch",
    pull: "PR_1",
    branch: "branch-1",
    expectedHead: HEAD,
  });
  await vi.waitFor(() =>
    expect(said()).toBe(
      "Merged into mainMerged as 9999999 just now. branch-1 was deleted on GitHub.",
    ),
  );
  expect(boxButtons(), "nothing is left to delete").toEqual([]);
});

it("offers the merge again once a read shows a merge with no answer didn't land", async () => {
  const app = await visit({
    world: (world) =>
      void world.host.writes.push({ kind: "unknown", applied: false }),
  });
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  await confirm(app);
  await vi.waitFor(() =>
    expect(said()).toBe("Nothing was mergedGitHub hasn't done it."),
  );
  await app.click(get("button", "Review and try again"));
  expect(tab("Conversation").getAttribute("aria-selected")).toBe("true");
  expect(said()).toBe("Ready to mergeGitHub finds nothing that stops it.");
  await app.click(get("button", "Squash and merge"));
  await confirm(app);
  await vi.waitFor(() => expect(said()).toMatch(/^Merged into main/));
  expect(kinds(app)).toEqual(["merge", "merge"]);
});

it("keeps a failed merge in the box until the user moves on", async () => {
  const app = await visit({
    world: (world) =>
      void world.host.writes.push({
        kind: "refused",
        message: "GitHub didn't do it: Required status check is expected.",
      }),
  });
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  await confirm(app);
  await vi.waitFor(() =>
    expect(said()).toBe(
      "GitHub didn't merge thisGitHub didn't do it: Required status check is expected. Nothing was merged.",
    ),
  );
  await app.refocusWindow();
  expect(said()).toMatch(/^GitHub didn't merge this/);
});

it("offers no merge to a role that can't, and says why", async () => {
  const app = await visit({ world: changed({ viewerPermission: "read" }) });
  await open(app, 1);
  expect(said()).toBe(
    "You can't merge hereYour role in this repository is Read. Someone with Write access can merge.",
  );
  expect(boxButtons()).toEqual([]);
});

it("merges anyway past a failing check that isn't required", async () => {
  const app = await visit({
    world: changed({
      mergeState: "unstable",
      checks: page([
        {
          name: "lint",
          state: "failed",
          required: false,
          startedAt: null,
          completedAt: null,
          url: null,
        },
      ]),
    }),
  });
  await open(app, 1);
  expect(boxButtons()).toEqual(["Squash and merge anyway", ""]);
  await app.click(get("button", "Squash and merge anyway"));
  await confirm(app, "Squash and merge anyway");
  await vi.waitFor(() => expect(kinds(app)).toEqual(["merge"]));
});

it("leaves the branch to GitHub when the repository deletes it after a merge", async () => {
  const app = await visit({
    world: changed({
      merge: {
        allowed: { merge: true, squash: true, rebase: true },
        preferred: "squash",
        deletesBranch: true,
      },
    }),
  });
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  const remote = choice(/^Delete branch-1 on GitHub/);
  expect(remote.checked).toBe(true);
  expect(remote.disabled).toBe(true);
  expect(popover().textContent).toContain(
    "GitHub deletes it after the merge, by this repository's settings.",
  );
  await confirm(app);
  await vi.waitFor(() => expect(said()).toMatch(/^Merged into main/));
  expect(kinds(app)).toEqual(["merge"]);
});

it("keeps a branch another open pull request uses", async () => {
  const app = await visit({
    world: changed({
      head: {
        ...pull(1).head,
        ref: { ...pull(1).head.ref!, othersOpen: 1 },
      },
    }),
  });
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  const remote = choice(/^Delete branch-1 on GitHub/);
  expect(remote.disabled).toBe(true);
  expect(popover().textContent).toContain("1 other open pull request uses it.");
});

it("deletes the local branch that tracks it with an undoable write, only after the merge", async () => {
  const app = await visit({
    world: (world) => void holding(world, 1, { worktree: null }),
  });
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  const local = choice(/^Delete the local branch too/);
  expect(popover().textContent).toContain("pr/1. Undo brings it back.");
  await app.click(local);
  const merging = app.bridge.hold("write");
  await confirm(app);
  await merging.arrived;
  expect(app.bridge.lines((request) => request.op === "write")).toEqual([]);
  merging.release();
  await vi.waitFor(() =>
    expect(app.bridge.lines((request) => request.op === "write")).toEqual([
      `write ${PIN} deleteBranch`,
    ]),
  );
  await vi.waitFor(() =>
    expect(said()).toContain(
      "Deleted pr/1 on this computer. Undo brings it back.",
    ),
  );
});

it("keeps a local branch that is checked out, and says where", async () => {
  const app = await visit({
    world: (world) => void holding(world, 1, {}),
  });
  await open(app, 1);
  await vi.waitFor(() => expect(query("group", "Local copy")).not.toBeNull());
  await app.click(get("button", "Squash and merge"));
  const local = choice(/^Delete the local branch too/);
  expect(local.disabled).toBe(true);
  expect(popover().textContent).toContain(
    "pr/1. It's checked out in pin-pr-1.",
  );
});

it("says why a merge sent nothing in the words every write uses", async () => {
  const app = await visit({
    world: (world) =>
      world.host.sent.set("octo octo/pin#1", [
        {
          attempt: "elsewhere",
          at: 1,
          write: { kind: "resolve", thread: "T9" },
          drafts: [],
          sending: true,
          applied: false,
        },
      ]),
  });
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  await confirm(app);
  expect(get("alert", undefined, popover()).textContent).toBe(
    "Another write to this pull request is still sending, or may have posted, so L1 Git sent nothing. Try again once that one ends.",
  );
  expect(sent(app)).toEqual([]);
});
