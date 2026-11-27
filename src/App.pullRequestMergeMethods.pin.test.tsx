// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { PullRequest } from "./domain/pullRequest";
import { get, installHarness, queryAll } from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import type { World } from "./test/fakeBridge";
import { open, visit } from "./test/pullRequests";

installHarness();

const METHODS = "l1git.mergeMethod.v1";
const box = () => get("region", "Merging");
const said = () => box().querySelector(".merge-said")?.textContent;
const boxButtons = () =>
  queryAll("button", undefined, box()).map((button) => button.textContent);
const popover = () => get("dialog", /^Merge #1 into main$/);
const field = (name: string | RegExp) =>
  get("textbox", name, popover()) as HTMLInputElement;
const method = (value: string) =>
  popover().querySelector<HTMLInputElement>(`input[value='${value}']`)!;
const sent = (app: Harness) => app.bridge.world.host.mutations;
const kinds = (app: Harness) => sent(app).map(({ kind }) => kind);

function change(world: World, number: number, fields: Partial<PullRequest>) {
  const key = pullKey("octo/pin", number);
  const was = world.host.details.get(key)!;
  world.host.details.set(key, { ...was, ...fields });
}

async function confirm(app: Harness, label = "Squash and merge") {
  await app.click(get("button", label, popover()));
}

it("names each method in the menu by its label, and describes it by its note", async () => {
  const app = await visit();
  await open(app, 1);
  await app.click(get("button", "Choose how to merge"));
  const described = (name: string) => {
    const item = get("menuitemradio", name);
    const note = item.getAttribute("aria-describedby") ?? "";
    return document.getElementById(note)?.textContent;
  };
  expect(described("Squash and merge")).toBe("One commit on main.");
  expect(described("Create a merge commit")).toBe(
    "Keeps the commit and adds a merge commit.",
  );
  expect(described("Rebase and merge")).toBe(
    "Puts the commit on main one by one.",
  );
});

it("picks the method from a menu, turns off what the repository turns off, and remembers the last one used", async () => {
  const app = await visit({
    world: (world) => {
      for (const number of [1, 2])
        change(world, number, {
          merge: {
            allowed: { merge: true, squash: true, rebase: false },
            preferred: "squash",
            deletesBranch: false,
          },
        });
    },
  });
  await open(app, 1);
  await app.click(get("button", "Choose how to merge"));
  const rebase = get("menuitemradio", /^Rebase and merge/);
  expect(rebase.getAttribute("aria-disabled")).toBe("true");
  expect(rebase.textContent).toContain(
    "Turned off in this repository's settings on GitHub.",
  );
  await app.click(rebase);
  expect(
    get("menuitemradio", /^Squash and merge/).getAttribute("aria-checked"),
  ).toBe("true");
  await app.click(get("menuitemradio", /^Create a merge commit/));
  await app.click(get("button", "Merge"));
  expect(method("merge").checked).toBe(true);
  expect(method("rebase").disabled).toBe(true);
  expect(field("Commit on main").value).toBe(
    "Merge pull request #1 from octo/branch-1",
  );
  expect(field("Commit message").value).toBe("Row 1");
  await app.click(method("squash"));
  expect(
    field("Commit on main").value,
    "until edited, it follows the method",
  ).toBe("Row 1 (#1)");
  await app.click(method("merge"));
  await app.type(field("Commit on main"), "Merge the reads");
  await app.click(method("squash"));
  await app.click(method("merge"));
  expect(field("Commit on main").value, "an edit stays").toBe(
    "Merge the reads",
  );
  await confirm(app, "Merge");
  await vi.waitFor(() => expect(kinds(app)).toEqual(["merge"]));
  expect(sent(app)[0]).toMatchObject({
    method: "merge",
    headline: "Merge the reads",
  });

  await app.click(get("button", "Pull requests"));
  await open(app, 2);
  expect(boxButtons()).toEqual(["Merge", ""]);
  await app.click(get("button", "Choose how to merge"));
  expect(get("menuitemradio", /^Create a merge commit/).textContent).toContain(
    "Last used in L1 Git.",
  );
});

it("remembers the method once GitHub merged, under this GitHub's name for the repository", async () => {
  const kept = () => JSON.parse(localStorage.getItem(METHODS) ?? "null");
  const others = { "github.com/octo/other": "rebase" };
  const app = await visit({
    stored: {
      [METHODS]: JSON.stringify({ ...others, "GitHub.com/Octo/Pin": 7 }),
    },
    world: (world) =>
      void world.host.writes.push({
        kind: "refused",
        message: "GitHub didn't do it: Required status check is expected.",
      }),
  });
  await open(app, 1);
  await app.click(get("button", "Squash and merge"));
  await confirm(app);
  await vi.waitFor(() => expect(said()).toMatch(/^GitHub didn't merge this/));
  expect(kept(), "a refused merge remembers nothing").toEqual({
    ...others,
    "GitHub.com/Octo/Pin": 7,
  });

  await app.click(get("button", "Review and try again"));
  await app.click(get("button", "Squash and merge"));
  await confirm(app);
  await vi.waitFor(() => expect(said()).toMatch(/^Merged into main/));
  expect(kept(), "the entry L1 Git can't read drops only itself").toEqual({
    ...others,
    "github.com/octo/pin": "squash",
  });
});

it("fits above the merge box in a short window, and scrolls inside with its buttons in sight", async () => {
  const app = await visit();
  await open(app, 1);
  box().getBoundingClientRect = () =>
    ({ top: 300, bottom: 420, left: 1000, right: 1400 }) as DOMRect;
  const height = window.innerHeight;
  window.innerHeight = 540;
  await app.click(get("button", "Squash and merge"));
  expect(popover().style.bottom).toBe("248px");
  expect(popover().style.maxHeight, "the room above the merge box").toBe(
    "276px",
  );
  box().getBoundingClientRect = () =>
    ({ top: 60, bottom: 180, left: 1000, right: 1400 }) as DOMRect;
  await app.act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  const { bottom, maxHeight } = popover().style;
  expect(
    540 - parseFloat(bottom) - parseFloat(maxHeight),
    "its top stays in the window",
  ).toBeGreaterThanOrEqual(16);
  window.innerHeight = height;
});
