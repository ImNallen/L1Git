// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  dialogs,
  focused,
  get,
  installHarness,
  query,
} from "./test/appHarness";
import { OTHER, PIN } from "./test/fixtures";
import { pullKey } from "./test/fakeBridge";
import {
  bar,
  barText,
  checkoutWrites,
  holding,
  popover,
  sent,
  tried,
  tryButton,
} from "./test/pullRequestCheckouts";
import { open, pull, visit } from "./test/pullRequests";

installHarness();

const sidebarRoots = () =>
  [...document.querySelectorAll(".repository-tree .repository-open")].map(
    (row) => row.getAttribute("title"),
  );

it("reads the copy once the pull request is read, and offers Try it locally next to Open on GitHub", async () => {
  const app = await visit();
  expect(app.bridge.count("pullCheckout"), "not before one opens").toBe(0);
  await open(app, 1);
  expect(app.bridge.log.filter(({ op }) => op === "pullCheckout")).toEqual([
    { op: "pullCheckout", path: PIN, ...sent(1) },
  ]);
  const toolbar = document.querySelector(".pull-detail-toolbar")!;
  expect(
    [...toolbar.querySelectorAll(".button")].map((each) => each.textContent),
  ).toEqual(["Try it locally", "Open on GitHub"]);
  expect(tryButton()!.getAttribute("aria-haspopup")).toBe("dialog");
  expect(tryButton()!.getAttribute("aria-expanded")).toBe("false");
  expect(bar(), "no copy, no bar").toBeNull();
});

it("the popover names the folder, the branch, and where pushes go, then creates the worktree and keeps it in the sidebar without opening it", async () => {
  const app = await visit();
  await open(app, 1);
  app.bridge.reset();
  await app.click(tryButton()!);

  expect(dialogs()).toEqual(["Try #1 locally"]);
  expect(tryButton()!.getAttribute("aria-expanded")).toBe("true");
  expect(focused()).toBe(`textbox Folder`);
  const folder = get("textbox", "Folder") as HTMLInputElement;
  expect(folder.value).toBe(tried(1));
  const branch = get("textbox", "Local branch") as HTMLInputElement;
  expect(branch.value).toBe("pr/1");
  expect(branch.readOnly).toBe(true);
  expect(popover().textContent).toContain(
    "Tracks origin/branch-1. Pushing from there updates the pull request.",
  );
  expect(popover().textContent).toContain(
    "Remove it any time from this pull request.",
  );
  expect(popover().textContent).not.toContain("When it's ready");
  expect(checkoutWrites(app.bridge), "opening it writes nothing").toEqual([]);

  await app.click(get("button", "Create worktree"));

  expect(checkoutWrites(app.bridge)).toEqual([
    { op: "tryPullRequest", path: PIN, ...sent(1), folder: tried(1) },
  ]);
  expect(dialogs()).toEqual([]);
  expect(barText()).toBe(
    `Checked out locally in ${tried(1)} · at 1111111, up to date`,
  );
  expect(tryButton(), "the toolbar no longer offers it").toBeNull();
  expect(focused()).toBe("group Local copy");
  expect(sidebarRoots()).toEqual([PIN, OTHER, tried(1)]);
  expect(app.bridge.count("snapshot", tried(1)), "not opened").toBe(0);
});

it("sends the folder as typed", async () => {
  const app = await visit();
  await open(app, 1);
  await app.click(tryButton()!);
  await app.type(get("textbox", "Folder"), "~/elsewhere");
  await app.click(get("button", "Create worktree"));
  expect(checkoutWrites(app.bridge)).toEqual([
    { op: "tryPullRequest", path: PIN, ...sent(1), folder: "~/elsewhere" },
  ]);
});

it("Escape and Cancel close the popover, change nothing, and give focus back to the button", async () => {
  const app = await visit();
  await open(app, 1);
  const opens = async () => {
    await app.click(tryButton()!);
    expect(dialogs()).toEqual(["Try #1 locally"]);
  };
  await opens();
  await app.press("Escape");
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("button Try it locally");
  await opens();
  await app.click(get("button", "Cancel"));
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("button Try it locally");
  expect(checkoutWrites(app.bridge)).toEqual([]);
});

it("an empty folder creates nothing", async () => {
  const app = await visit();
  await open(app, 1);
  await app.click(tryButton()!);
  await app.type(get("textbox", "Folder"), "  ");
  const create = get("button", "Create worktree");
  expect(create.getAttribute("aria-disabled")).toBe("true");
  await app.click(create);
  expect(checkoutWrites(app.bridge)).toEqual([]);
});

it("a refusal stays in the popover, on the folder, until the folder changes", async () => {
  const app = await visit();
  await open(app, 1);
  app.bridge.fail("tryPullRequest", {
    kind: "conflict",
    message: `${tried(1)} is not empty, so Git cannot make a worktree there.`,
  });
  await app.click(tryButton()!);
  await app.click(get("button", "Create worktree"));

  expect(dialogs()).toEqual(["Try #1 locally"]);
  expect(get("alert").textContent).toBe(
    `${tried(1)} is not empty, so Git cannot make a worktree there.`,
  );
  const folder = get("textbox", "Folder");
  expect(folder.getAttribute("aria-invalid")).toBe("true");
  expect(bar()).toBeNull();
  await app.type(folder, `${tried(1)}-2`);
  expect(query("alert")).toBeNull();
});

it("a worktree whose post-checkout hook failed is made and kept, and the bar shows the hook's output until dismissed", async () => {
  const app = await visit({
    bridge: (bridge) =>
      bridge.respond("tryPullRequest", (_request, _world, fallback) => {
        const ready = fallback() as { worktree: object };
        return {
          ...ready,
          worktree: {
            ...ready.worktree,
            trouble: {
              kind: "afterHookFailed",
              message:
                "Git made the worktree pin-pr-1, but the post-checkout hook failed. Remove worktree takes it away.",
              output: "npm ERR! missing script: prepare\n",
            },
          },
        };
      }),
  });
  await open(app, 1);
  await app.click(tryButton()!);
  await app.click(get("button", "Create worktree"));

  const said = bar()!.querySelector(".pull-checkout-said")!;
  expect(said.getAttribute("role")).toBe("status");
  expect(said.textContent).toBe(
    "Git made the worktree pin-pr-1, but the post-checkout hook failed. Remove worktree takes it away.npm ERR! missing script: prepare",
  );
  expect(sidebarRoots()).toEqual([PIN, OTHER, tried(1)]);
  await app.refocusWindow();
  expect(
    bar()!.querySelector(".pull-checkout-said"),
    "a reread keeps it",
  ).not.toBeNull();
  await app.click(get("button", "Dismiss"));
  expect(bar()!.querySelector(".pull-checkout-said")).toBeNull();
});

it("offers a kept branch again, and checks it out at its own tip", async () => {
  const app = await visit({
    world: (world) => holding(world, 1, { ahead: 2, worktree: null }),
  });
  await open(app, 1);
  expect(barText()).toBe(
    "Kept locally as pr/1 · at a1a1a1a, 2 commits ahead of the pull request, not checked out",
  );
  await app.click(tryButton()!);
  expect((get("textbox", "Folder") as HTMLInputElement).value).toBe(tried(1));
  await app.click(get("button", "Create worktree"));
  expect(barText()).toBe(
    `Checked out locally in ${tried(1)} · at a1a1a1a, 2 commits ahead of the pull request`,
  );
});

it("says where pushes go for a fork, and when they go nowhere", async () => {
  const maja = { owner: "maja", repo: "pin" };
  const fork = (number: number, maintainerCanModify: boolean) =>
    pull(number, {
      head: {
        ...pull(number).head,
        crossRepository: true,
        repository: number === 5 ? null : maja,
        maintainerCanModify,
      },
    });
  const app = await visit({
    world: (world) => {
      world.host.details.set(pullKey("octo/pin", 1), fork(1, true));
      world.host.details.set(pullKey("octo/pin", 2), fork(2, false));
      world.host.details.set(pullKey("octo/pin", 5), fork(5, true));
    },
  });
  const said = async (number: number) => {
    await open(app, number);
    await app.click(tryButton()!);
    const text = popover().querySelector(".pull-try-pushes")!.textContent;
    await app.press("Escape");
    await app.click(get("button", "Pull requests"));
    return text;
  };
  expect(await said(1)).toBe(
    "Tracks maja/branch-1, on a remote L1 Git adds for maja's fork. Pushing from there updates the pull request.",
  );
  expect(await said(2)).toBe(
    "The author doesn't allow edits from maintainers, so commits you make there stay local.",
  );
  expect(await said(5)).toBe(
    "The fork this pull request came from is gone, so commits you make there stay local.",
  );
});

it("says that commits stay local when you can't push to the repository", async () => {
  const app = await visit({
    world: (world) =>
      world.host.details.set(
        pullKey("octo/pin", 1),
        pull(1, { viewerPermission: "read" }),
      ),
  });
  await open(app, 1);
  await app.click(tryButton()!);
  expect(popover().querySelector(".pull-try-pushes")!.textContent).toBe(
    "You can't push to this repository, so commits you make there stay local.",
  );
});

it("offers nothing on a closed pull request with no copy, and shows the bar of a merged one that has one", async () => {
  const merged = { kind: "merged" as const, at: "2026-11-02T03:00:00Z" };
  const app = await visit({
    world: (world) => {
      world.host.details.set(
        pullKey("octo/pin", 1),
        pull(1, { state: merged }),
      );
      world.host.details.set(
        pullKey("octo/pin", 2),
        pull(2, { state: { kind: "closed", at: "2026-11-02T03:00:00Z" } }),
      );
      holding(world, 1, {});
    },
  });
  await open(app, 1);
  expect(tryButton()).toBeNull();
  expect(barText()).toBe(
    `Checked out locally in ${tried(1)} · at 1111111, up to date`,
  );
  await app.click(get("button", "Pull requests"));
  await open(app, 2);
  expect(tryButton()).toBeNull();
  expect(bar()).toBeNull();
});
