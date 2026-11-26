// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { get, installHarness, query } from "./test/appHarness";
import type { World } from "./test/fakeBridge";
import { PIN } from "./test/fixtures";
import {
  bar,
  barText,
  checkoutWrites,
  holding,
  tried,
} from "./test/pullRequestCheckouts";
import { open, visit } from "./test/pullRequests";

installHarness();

const two = (world: World) => {
  holding(world, 1, { behind: 1 });
  holding(world, 2, {});
};
const one = `Checked out locally in ${tried(1)}`;
const second = `Checked out locally in ${tried(2)} · at 1111111, up to date`;

async function toList(app: Awaited<ReturnType<typeof visit>>) {
  await app.click(get("button", "Pull requests"));
}

it("a read of the copy that lands after you open another pull request is dropped", async () => {
  const app = await visit({ world: two });
  const late = app.bridge.hold("pullCheckout", PIN);
  await open(app, 1);
  await late.arrived;
  await toList(app);
  await open(app, 2);
  expect(barText()).toBe(second);
  late.release();
  await app.settle();
  expect(barText()).toBe(second);
  await toList(app);
  await open(app, 1);
  expect(barText()).toBe(
    `${one} · at c0c0c0c, 1 commit behind the pull request`,
  );
});

it("while one pull request's copy changes, another shows its own and says why its writes wait", async () => {
  const app = await visit({ world: two });
  await open(app, 1);
  const held = app.bridge.hold("updatePullRequest");
  await app.click(get("button", "Update"));
  await held.arrived;
  await toList(app);
  await open(app, 2);
  expect(barText()).toBe(second);
  const remove = get("button", "Remove worktree");
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  await app.click(remove);
  expect(get("alert").textContent).toBe(
    "Could not remove the worktree. Another change is still running. Try again when it ends.",
  );
  held.release();
  await app.settle();
  expect(barText()).toBe(second);
  expect(checkoutWrites(app.bridge).map(({ op }) => op)).toEqual([
    "updatePullRequest",
  ]);
  await toList(app);
  await open(app, 1);
  expect(barText()).toBe(`${one} · at 1111111, up to date`);
});

it("a read the window asks for while the copy changes waits for the write, then runs once", async () => {
  const app = await visit({ world: two });
  await open(app, 1);
  const held = app.bridge.hold("updatePullRequest");
  await app.click(get("button", "Update"));
  await held.arrived;
  const reads = app.bridge.count("pullCheckout");
  await app.refocusWindow();
  expect(app.bridge.count("pullCheckout"), "none during the write").toBe(reads);
  held.release();
  await app.settle();
  expect(app.bridge.count("pullCheckout")).toBe(reads + 1);
  expect(barText()).toBe(`${one} · at 1111111, up to date`);
});

it("a copy it cannot read says why, and Try again reads it again", async () => {
  const app = await visit({ world: two });
  const heal = app.bridge.fail("pullCheckout", {
    kind: "lockHeld",
    message: "Another Git process holds the index.",
  });
  await open(app, 1);
  expect(get("alert").textContent).toBe(
    "Could not read this pull request's local copy. Another Git process holds the index.Try again",
  );
  heal();
  await app.click(get("button", "Try again"));
  expect(query("alert")).toBeNull();
  expect(bar()).not.toBeNull();
  expect(barText()).toBe(
    `${one} · at c0c0c0c, 1 commit behind the pull request`,
  );
});
