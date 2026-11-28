import { toolbarItem } from "./test/appHarness";
// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  dialogs,
  get,
  historyRow,
  installHarness,
  mountApp,
  query,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { Refusal } from "./test/fakeBridge";
import {
  C3,
  C4,
  C5,
  C6,
  history,
  PIN,
  rebaseInProgress,
  STAMP,
} from "./test/fixtures";
import type { Applied, RepositoryRoot } from "./domain/repository";

installHarness();

const TITLE = "Rebasing main onto origin/main · commit 2 of 3";

const panel = () => get("region", TITLE);

const writes = (app: Harness) =>
  app.bridge.log
    .filter((request) => request.op === "write")
    .map(({ operation, expect }) => ({ operation, expect }));

const of = {
  branch: "refs/heads/main",
  onto: C3,
  origHead: C4,
  step: C6,
};

it("a rebase started in a terminal opens its panel on the next refocus", async () => {
  const app = await mountApp();
  expect(query("region", TITLE)).toBeNull();
  app.bridge.world.merges.set(PIN, rebaseInProgress(PIN, ["notes.txt"]));
  await app.refocusWindow();
  expect(panel().textContent).toContain("666666 Rebased commit");
  expect(panel().textContent).toContain(
    "All conflicts are resolved. Review the result, then continue.",
  );
  expect(query("region", "Branch merge")).toBeNull();
  expect(query("button", /^Finish/)).toBeNull();
});

it("Continue is held until every conflict is resolved", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(
        PIN,
        rebaseInProgress(PIN, ["notes.txt"], {
          unresolved: ["notes.txt"],
          tree: null,
        }),
      ),
  });
  expect(panel().textContent).toContain(
    "1 file still has a conflict. Resolve it, then continue the rebase.",
  );
  app.bridge.reset();
  const button = get("button", "Continue rebase");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("title")).toBe(
    "Resolve every conflicted file first.",
  );
  await app.click(button);
  expect(app.bridge.count("write")).toBe(0);
});

it("Continue that ends the rebase lands one Undo for the whole rebase", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN, rebaseInProgress(PIN, ["notes.txt"])),
  });
  app.bridge.respond("write", (request, world, fallback) => {
    const entry = fallback() as Applied;
    world.merges.delete(request.path as RepositoryRoot);
    world.histories.set(request.path as RepositoryRoot, history(entry));
    return entry;
  });
  app.bridge.reset();
  await app.click(get("button", "Continue rebase"));
  expect(writes(app)).toEqual([
    {
      operation: { kind: "continueRebase", of, staged: STAMP, tree: C3 },
      expect: { head: { kind: "detached", oid: C5 } },
    },
  ]);
  expect(query("region", TITLE)).toBeNull();
  expect(
    await toolbarItem(app, "More", "Undo Rebase main onto origin/main"),
  ).toBeTruthy();
});

it("Continue that stops on the next commit moves the panel there, with no failure notice", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN, rebaseInProgress(PIN, ["notes.txt"])),
  });
  app.bridge.respond("write", (_request, world) => {
    world.merges.set(
      PIN,
      rebaseInProgress(PIN, ["later.txt"], {
        step: C4,
        done: 3,
        unresolved: ["later.txt"],
        tree: null,
      }),
    );
    throw new Refusal({
      kind: "rebaseStopped",
      message:
        "The rebase stopped on a conflict in commit 3 of 3. Resolve it, then continue or abort the rebase.",
      output: "",
    });
  });
  await app.click(get("button", "Continue rebase"));
  expect(
    get("region", "Rebasing main onto origin/main · commit 3 of 3"),
  ).toBeTruthy();
  expect(query("alert", /Could not/)).toBeNull();
});

it("a hook that stops the commit shows what Git printed in the panel", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN, rebaseInProgress(PIN, ["notes.txt"])),
  });
  app.bridge.fail("write", {
    kind: "rebaseStopped",
    message:
      "Git did not commit this step, so the rebase is still on commit 2 of 3 and the result stays staged. Fix what Git reported, then continue or abort the rebase.",
    output: "prepare-commit-msg said no\n",
  });
  await app.click(get("button", "Continue rebase"));
  const alert = get("alert", /Git did not commit this step/);
  expect(alert.textContent).toContain("prepare-commit-msg said no");
  expect(panel()).toBeTruthy();
});

it("a step whose result matches HEAD offers Skip commit instead of Continue", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(
        PIN,
        rebaseInProgress(PIN, ["notes.txt"], { empty: true }),
      ),
  });
  expect(query("button", "Continue rebase")).toBeNull();
  expect(panel().textContent).toContain(
    "The staged result matches HEAD, so this commit has nothing left to apply. Skip it to go on with the rebase.",
  );
  app.bridge.reset();
  await app.click(get("button", "Skip commit"));
  expect(writes(app)).toEqual([
    {
      operation: { kind: "skipRebase", of, staged: STAMP },
      expect: { head: { kind: "detached", oid: C5 } },
    },
  ]);
});

it("Abort asks first, names what it discards, and puts the branch back", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN, rebaseInProgress(PIN, ["notes.txt"])),
  });
  app.bridge.reset();
  await app.click(get("button", "Abort rebase…"));
  expect(dialogs()).toEqual(["Abort this rebase?"]);
  const dialog = get("dialog", "Abort this rebase?");
  expect(dialog.textContent).toContain(
    "main goes back to 4444444 exactly as before you started.",
  );
  expect(get("region", "Discarded").textContent).toContain(
    "The commit already rebased onto origin/main",
  );
  expect(dialog.textContent).toContain(
    "A staged change outside the commit's files, or an unstaged edit outside a conflicted file, blocks Abort.",
  );
  expect(app.bridge.count("rebaseAbort")).toBe(0);
  await app.click(get("button", "Abort rebase"));
  expect(app.bridge.log.filter(({ op }) => op === "rebaseAbort")).toEqual([
    {
      op: "rebaseAbort",
      path: PIN,
      of,
      head: { kind: "detached", oid: C5 },
    },
  ]);
  expect(query("region", TITLE)).toBeNull();
  expect(get("region", "Rebase").textContent).toContain("Rebase aborted.");
});

it("the inspector shows the rebase with no commit message fields", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN, rebaseInProgress(PIN, ["notes.txt"])),
  });
  await app.click(historyRow("Uncommitted changes in pin,"));
  await app.click(get("button", "1 of 1 resolved"));
  const inspector = get("complementary", "Commit inspector");
  expect(inspector.textContent).toContain(
    "Continue commits “Rebased commit” on HEAD with its own message, then goes on with the rest of the rebase. main moves only when the rebase ends.",
  );
  expect(inspector.textContent).toContain(
    "Once the rebase ends, Undo puts main back where it was.",
  );
  expect(query("region", "Commit message")).toBeNull();
  expect(query("group", "Commit")).toBeNull();
});
