// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import {
  focused,
  get,
  installHarness,
  mountApp,
  query,
  queryAll,
  refRow,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey, pullsKey } from "./test/fakeBridge";
import type { World } from "./test/fakeBridge";
import { C3, C4, C5, C6, PIN } from "./test/fixtures";
import { page, pull } from "./test/pullRequests";
import { branchRefSchema } from "./domain/overview";
import { refSchema } from "./domain/repository";
import type { Branch, Oid } from "./domain/repository";

installHarness();

const github = { owner: "octo", repo: "pin" };

const remote = (name: string, oid: Oid): Branch => ({
  kind: "remote",
  reference: refSchema.parse(`refs/remotes/origin/${name}`),
  name: `origin/${name}`,
  oid,
  remote: "origin",
});

/** PIN on GitHub as octo/pin, with feature pushed to origin and main there
 * at `base`, and the user signed in. */
function onGitHub(base: Oid = C3) {
  return (world: World) => {
    const snapshot = world.snapshots.get(PIN)!;
    world.snapshots.set(PIN, {
      ...snapshot,
      remotes: [
        { name: "origin", url: "https://github.com/octo/pin.git", github },
      ],
      branches: [
        ...snapshot.branches.filter((branch) => branch.kind === "local"),
        remote("main", base),
        remote("release", C3),
        remote("feature", C5),
      ],
    });
    world.overviews.set(PIN, { ...world.overviews.get(PIN)!, github });
    world.host.pulls.set(pullsKey("octo/pin", "open"), page([]));
    world.host.pulls.set(pullsKey("octo/pin", "recentlyMerged"), page([]));
    world.host.details.set(pullKey("octo/pin", 41), pull(41));
    world.host.details.set(pullKey("octo/pin", 7), pull(7));
    signedIn(world);
  };
}

function signedIn(world: World) {
  world.host.status = {
    ...world.host.status,
    github: {
      kind: "connected",
      login: "octo",
      api: "https://api.github.com/",
      method: "gh",
      access: "private",
      connectedAt: 1,
    },
  };
}

const popover = () => get("dialog", "Open a pull request");
const field = (name: string) =>
  get("textbox", name, popover()) as HTMLInputElement;
const button = (name: string | RegExp) => get("button", name, popover());
const openings = (app: Harness) => app.bridge.world.host.openings;
const notification = () =>
  document
    .querySelector(".notifications .notification")
    ?.querySelector(".notification-message")?.textContent ?? null;

async function branchMenu(app: Harness, name: string) {
  await app.contextMenu(refRow(`refs/heads/${name}`)!);
  return queryAll("menuitem", undefined, get("menu"));
}

async function openFrom(app: Harness, name: string) {
  await branchMenu(app, name);
  await app.click(get("menuitem", /^Open pull request…/));
}

it("offers Open pull request first in the branch menu, opens it once with what the popover showed, and says so", async () => {
  const app = await mountApp({ world: onGitHub() });
  const items = await branchMenu(app, "feature");
  expect(items[0]?.textContent).toBe("Open pull request…into main");
  expect(
    get("menu").children[1]?.getAttribute("role"),
    "a separator follows it",
  ).toBe("separator");
  await app.click(items[0]!);

  expect(popover().textContent).toContain("Merge feature into main");
  expect(button("Base branch, main").textContent).toBe("main");
  expect(field("Title").value, "the oldest commit's subject").toBe("Main tip");
  expect(focused()).toBe("textbox Title");
  expect(field("Description").value).toBe("");
  expect(field("Description").placeholder).toBe(
    "Why this change, and where a reviewer should start.",
  );
  const commits = get("region", "Commits", popover());
  expect(commits.textContent).toContain("2 commits · 1 file changed");
  expect(commits.textContent).toContain("+1 −1");
  expect(
    [...commits.querySelectorAll("li")].map((row) => row.textContent),
  ).toEqual(["5555555Feature work", "4444444Main tip"]);
  expect(popover().textContent).toContain("Opening has no Undo.");
  expect(openings(app), "nothing leaves before the click").toEqual([]);

  await app.type(field("Title"), "Feature work");
  await app.type(field("Description"), "Start at feature.txt.");
  await app.click(button("Open pull request"));

  await vi.waitFor(() =>
    expect(openings(app)).toEqual([
      {
        repositoryId: "R_pin",
        base: "main",
        head: "feature",
        title: "Feature work",
        body: "Start at feature.txt.",
        draft: false,
      },
    ]),
  );
  await vi.waitFor(() =>
    expect(query("dialog", "Open a pull request")).toBeNull(),
  );
  expect(notification()).toBe(
    "Opened pull request #41 from feature into main.",
  );
  const shown = document.querySelector(".notifications .notification")!;
  expect(
    queryAll("button", undefined, shown).map((each) => each.textContent),
  ).toEqual(["Open pull request", "Stay here"]);
  await app.click(get("button", "Open pull request", shown));
  expect(get("complementary", "Pull request sidebar")).toBeTruthy();
  expect(
    app.bridge.hostLog.some(
      (request) => request.op === "pullRequest" && request.number === 41,
    ),
  ).toBe(true);
  expect(openings(app)).toHaveLength(1);
});

it("prefills the description from a single commit, and opens a draft from the arrow", async () => {
  const app = await mountApp({
    world: onGitHub(C4),
    bridge: (bridge) =>
      bridge.respond("commitDetail", (_request, _world, fallback) => {
        const detail = fallback() as {
          target: { kind: string; message: string };
        };
        return {
          ...detail,
          target: {
            ...detail.target,
            message: "Feature work\n\nStart at feature.txt.\n",
          },
        };
      }),
  });
  await openFrom(app, "feature");
  expect(field("Title").value).toBe("Feature work");
  await vi.waitFor(() =>
    expect(field("Description").value).toBe("Start at feature.txt."),
  );
  await app.click(button("Choose how to open"));
  const draft = get("menuitemradio", "Open as draft");
  expect(draft.textContent).toContain("asks no one yet");
  await app.click(draft);
  await app.click(button("Open as draft"));
  await vi.waitFor(() =>
    expect(openings(app)).toMatchObject([{ draft: true, base: "main" }]),
  );
});

it("picks the base from the branches on origin", async () => {
  const app = await mountApp({ world: onGitHub() });
  await openFrom(app, "feature");
  await app.click(button("Base branch, main"));
  expect(queryAll("menuitemradio").map((choice) => choice.textContent)).toEqual(
    ["main", "release"],
  );
  await app.click(get("menuitemradio", "release"));
  expect(button("Base branch, release")).toBeTruthy();
  await app.click(button("Open pull request"));
  await vi.waitFor(() =>
    expect(openings(app)).toMatchObject([{ base: "release" }]),
  );
});

it("leads to the pull request already open from the branch, and sends nothing", async () => {
  const app = await mountApp({
    world: (world) => {
      onGitHub()(world);
      world.host.opens.set("octo/pin", [
        { number: 7, head: "feature", base: "main" },
      ]);
    },
  });
  await openFrom(app, "feature");
  expect(popover().textContent).toContain(
    "feature already has pull request #7 open into main.",
  );
  expect(query("textbox", "Title", popover())).toBeNull();
  await app.click(button("View pull request"));
  expect(query("dialog", "Open a pull request")).toBeNull();
  expect(get("complementary", "Pull request sidebar")).toBeTruthy();
  expect(
    app.bridge.hostLog.some(
      (request) => request.op === "pullRequest" && request.number === 7,
    ),
  ).toBe(true);
  expect(openings(app)).toEqual([]);
});

it("says when GitHub didn't answer, and Check GitHub finds the pull request that landed", async () => {
  const app = await mountApp({
    world: (world) => {
      onGitHub()(world);
      world.host.openScript.push({ kind: "unknown", landed: true });
    },
  });
  await openFrom(app, "feature");
  await app.click(button("Open pull request"));
  await vi.waitFor(() =>
    expect(popover().textContent).toContain(
      "GitHub didn't answer in time, so the pull request may already be open. L1 Git looks for it on GitHub before it sends anything again.",
    ),
  );
  expect(
    (popover().querySelector(".open-pull-form") as HTMLFieldSetElement)
      .disabled,
    "the form is dimmed and closed to edits",
  ).toBe(true);
  expect(popover().querySelector("footer")?.textContent).toMatch(
    /^Sent .+, no answer\.CloseCheck GitHub$/,
  );
  expect(query("button", "Open pull request", popover())).toBeNull();

  await app.click(button("Check GitHub"));
  await vi.waitFor(() =>
    expect(query("dialog", "Open a pull request")).toBeNull(),
  );
  expect(notification()).toBe(
    "Opened pull request #41 from feature into main.",
  );
  expect(openings(app), "Check GitHub reads, and sends nothing").toHaveLength(
    1,
  );
});

it("says the host's words when its own answer was lost on the way back", async () => {
  const app = await mountApp({ world: onGitHub() });
  await openFrom(app, "feature");
  const lost = app.bridge.failHost(
    { kind: "unreachable", message: "The connection closed." },
    "octo/pin",
  );
  await app.click(button("Open pull request"));
  await vi.waitFor(() => expect(button("Check GitHub")).toBeTruthy());
  const said = get("alert", undefined, popover()).textContent;
  expect(said).toBe(
    "L1 Git sent this to its GitHub connection and did not hear back, so the pull request may already be open. L1 Git looks for it on GitHub before it sends anything again.",
  );
  expect(said, "GitHub may have answered L1 Git in time").not.toContain(
    "GitHub didn't answer",
  );
  lost();
});

it("lets the user open again when Check GitHub finds nothing, and says what GitHub refused", async () => {
  const app = await mountApp({
    world: (world) => {
      onGitHub()(world);
      world.host.openScript.push(
        { kind: "unknown", landed: false },
        { kind: "refused", message: "GitHub didn't do it: No commits." },
      );
    },
  });
  await openFrom(app, "feature");
  await app.click(button("Open pull request"));
  await vi.waitFor(() => expect(button("Check GitHub")).toBeTruthy());
  await app.click(button("Check GitHub"));
  await vi.waitFor(() =>
    expect(popover().textContent).toContain(
      "GitHub has no pull request from feature into main, so you can open it again.",
    ),
  );
  await app.click(button("Open pull request"));
  await vi.waitFor(() =>
    expect(get("alert", undefined, popover()).textContent).toBe(
      "GitHub didn't do it: No commits.",
    ),
  );
  await app.click(button("Open pull request"));
  await vi.waitFor(() =>
    expect(query("dialog", "Open a pull request")).toBeNull(),
  );
  expect(openings(app)).toHaveLength(3);
});

it("asks to push a branch that isn't on origin first, and sends nothing", async () => {
  const app = await mountApp({ world: onGitHub() });
  await openFrom(app, "topic");
  expect(popover().textContent).toContain(
    "topic isn't on origin yet. Publish it first, then open the pull request.",
  );
  const open = button("Open pull request");
  expect(open.getAttribute("aria-disabled")).toBe("true");
  await app.click(open);
  expect(openings(app)).toEqual([]);
});

/** PIN with topic at `at` and origin's copy of it at `there`. */
function topicAt(at: Oid, there: Oid) {
  return (world: World) => {
    onGitHub()(world);
    const snapshot = world.snapshots.get(PIN)!;
    world.snapshots.set(PIN, {
      ...snapshot,
      branches: [
        ...snapshot.branches.map((branch) =>
          branch.name === "topic" ? { ...branch, oid: at } : branch,
        ),
        remote("topic", there),
      ],
    });
  };
}

it("says a branch only behind origin's copy needs a pull, not that it moved apart", async () => {
  const app = await mountApp({ world: topicAt(C4, C6) });
  await openFrom(app, "topic");
  expect(popover().textContent).toContain(
    "origin/topic has 1 commit that topic doesn't. Pull first, so the pull request shows what you see here.",
  );
  expect(popover().textContent).not.toContain("moved on");
  expect(button("Open pull request").getAttribute("aria-disabled")).toBe(
    "true",
  );
});

it("takes Git's count of what origin lacks when the history loaded stops short", async () => {
  const app = await mountApp({
    world: (world) => {
      topicAt(C6, C4)(world);
      const snapshot = world.snapshots.get(PIN)!;
      world.snapshots.set(PIN, {
        ...snapshot,
        commits: snapshot.commits.filter((commit) => commit.oid === C6),
      });
      const overview = world.overviews.get(PIN)!;
      world.overviews.set(PIN, {
        ...overview,
        branches: [
          ...overview.branches,
          {
            reference: branchRefSchema.parse("refs/heads/topic"),
            name: "topic",
            oid: C6,
            role: "other",
            checkedOutAt: null,
            state: {
              kind: "ahead",
              upstream: refSchema.parse("refs/remotes/origin/topic"),
              ahead: 1,
            },
          },
        ],
      });
    },
  });
  await openFrom(app, "topic");
  expect(popover().textContent).toContain(
    "origin doesn't have 1 commit of topic yet. Push first, then open the pull request.",
  );
  expect(popover().textContent).not.toContain("moved on");
});

it("is unavailable without a GitHub sign-in or a repository on GitHub", async () => {
  const app = await mountApp({
    world: (world) => {
      onGitHub()(world);
      world.host.status = {
        ...world.host.status,
        github: { kind: "notConnected", ended: null },
      };
    },
  });
  const [first] = await branchMenu(app, "feature");
  expect(first?.getAttribute("aria-disabled")).toBe("true");
  expect(first?.textContent).toBe("Open pull request…Not signed in");
  await app.click(first!);
  expect(query("dialog", "Open a pull request")).toBeNull();

  const plain = await mountApp({ world: signedIn });
  const [item] = await branchMenu(plain, "feature");
  expect(item?.textContent).toBe("Open pull request…Not on GitHub");
  expect(item?.getAttribute("aria-disabled")).toBe("true");
});

it("opens from the command palette for the checked-out branch", async () => {
  const app = await mountApp({
    world: (world) => {
      onGitHub()(world);
      const snapshot = world.snapshots.get(PIN)!;
      world.snapshots.set(PIN, {
        ...snapshot,
        head: {
          kind: "attached",
          reference: refSchema.parse("refs/heads/topic"),
          oid: C6,
        },
        branches: [...snapshot.branches, remote("topic", C6)],
      });
    },
  });
  await app.runPaletteItem("Open pull request…");
  expect(popover().textContent).toContain("Merge topic into main");
  expect(field("Title").value).toBe("Main tip");
});
