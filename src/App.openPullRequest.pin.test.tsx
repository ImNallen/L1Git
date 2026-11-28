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
import { pushIntentSchema, pushReportSchema } from "./domain/push";
import type { PushOutcome } from "./domain/push";
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

it("asks to check out a branch that isn't on origin before publishing it, and sends nothing", async () => {
  const app = await mountApp({ world: onGitHub() });
  await openFrom(app, "topic");
  expect(popover().textContent).toContain(
    "topic isn't on origin yet. Check it out to publish it, then open the pull request.",
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
        branches: snapshot.branches.map((branch) =>
          branch.name === "topic" && branch.kind === "local"
            ? {
                ...branch,
                upstream: refSchema.parse("refs/remotes/origin/topic"),
              }
            : branch,
        ),
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
    "origin doesn't have 1 commit of topic yet. Check it out to push, then open the pull request.",
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

/** PIN with topic checked out, tracking `upstream`, and origin's copy of it
 * at `there`. */
function onTopic(there: Oid | null, upstream: string | null = null) {
  return (world: World) => {
    onGitHub()(world);
    const snapshot = world.snapshots.get(PIN)!;
    world.snapshots.set(PIN, {
      ...snapshot,
      head: {
        kind: "attached",
        reference: refSchema.parse("refs/heads/topic"),
        oid: C6,
      },
      branches: [
        ...snapshot.branches.map((branch) =>
          branch.name === "topic" && branch.kind === "local"
            ? {
                ...branch,
                upstream: upstream === null ? null : refSchema.parse(upstream),
              }
            : branch,
        ),
        ...(there === null ? [] : [remote("topic", there)]),
      ],
    });
  };
}

const TRACKED = "refs/remotes/origin/topic";

it("opens from the command palette for the checked-out branch", async () => {
  const app = await mountApp({ world: onTopic(C6) });
  await app.runPaletteItem("Open pull request…");
  expect(popover().textContent).toContain("Merge topic into main");
  expect(field("Title").value).toBe("Main tip");
});

const intent = (purpose: "publish" | "upstream") =>
  pushIntentSchema.parse({
    purpose,
    branch: "refs/heads/topic",
    source: C6,
    remote: "origin",
    destination: "refs/heads/topic",
    endpoint: "https://github.com/octo/pin.git",
    tracksEndpoint: true,
    fingerprint: "c".repeat(40),
  });

/** Answers each push with `outcome`, and notes how many pull requests had
 * been opened when it ran. */
function pushing(app: Harness, outcome: PushOutcome) {
  const openedBefore: number[] = [];
  app.bridge.respond("push", (_request, world) => {
    openedBefore.push(world.host.openings.length);
    return pushReportSchema.parse({
      outcome,
      refresh: { kind: "failed", message: "Not refreshed." },
    });
  });
  return openedBefore;
}

it("publishes a checked-out branch that isn't on origin, then opens its pull request", async () => {
  const app = await mountApp({
    world: onTopic(null),
    bridge: (bridge) =>
      bridge.respond("preparePublish", () => ({
        kind: "ready",
        intent: intent("publish"),
      })),
  });
  const openedBefore = pushing(app, {
    kind: "published",
    tracking: { kind: "set" },
  });
  await app.runPaletteItem("Open pull request…");
  expect(popover().textContent).toContain(
    "topic isn't on origin yet. L1 Git publishes it first, with your Git credentials, then opens the pull request.",
  );
  expect(popover().querySelector("footer")?.textContent).toContain(
    "Neither step has an Undo.",
  );
  await app.click(button("Publish and open"));

  await vi.waitFor(() =>
    expect(openings(app)).toMatchObject([{ head: "topic", base: "main" }]),
  );
  expect(openedBefore, "it published once, before GitHub was asked").toEqual([
    0,
  ]);
  expect(
    app.bridge.log.find((request) => request.op === "preparePublish")?.choice,
  ).toEqual({ remote: "origin", destination: "refs/heads/topic" });
  await vi.waitFor(() =>
    expect(notification()).toBe(
      "Opened pull request #41 from topic into main.",
    ),
  );
});

it("pushes a branch origin is behind on first, and a rejected push opens nothing", async () => {
  const app = await mountApp({
    world: (world) => {
      onTopic(C4, TRACKED)(world);
      world.pushes.set(PIN, { kind: "ready", intent: intent("upstream") });
    },
  });
  pushing(app, { kind: "rejected", message: "The remote said no." });
  await app.runPaletteItem("Open pull request…");
  expect(popover().textContent).toContain(
    "origin doesn't have 1 commit of topic yet. L1 Git pushes first, with your Git credentials, then opens the pull request.",
  );
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(get("alert", undefined, popover()).textContent).toBe(
      "Push rejected. The remote said no. L1 Git opened no pull request.",
    ),
  );
  expect(openings(app), "a rejected push stops before GitHub").toEqual([]);

  const openedBefore = pushing(app, { kind: "pushed" });
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(openings(app)).toMatchObject([{ head: "topic" }]),
  );
  expect(openedBefore).toEqual([0]);
});

it("pushes nothing to a destination other than the head on origin", async () => {
  const app = await mountApp({
    world: (world) => {
      onTopic(C4, TRACKED)(world);
      world.pushes.set(PIN, {
        kind: "ready",
        intent: {
          ...intent("upstream"),
          destination: branchRefSchema.parse("refs/heads/elsewhere"),
        },
      });
    },
  });
  await app.runPaletteItem("Open pull request…");
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(get("alert", undefined, popover()).textContent).toBe(
      "topic would go to origin/elsewhere, not origin/topic, so L1 Git pushed nothing. L1 Git opened no pull request.",
    ),
  );
  expect(app.bridge.count("push")).toBe(0);
  expect(openings(app)).toEqual([]);
});

it("says to switch to the worktree a branch is checked out in to publish it", async () => {
  const app = await mountApp({
    world: (world) => {
      onGitHub()(world);
      const snapshot = world.snapshots.get(PIN)!;
      world.snapshots.set(PIN, {
        ...snapshot,
        branches: snapshot.branches.filter(
          (branch) => branch.name !== "origin/feature",
        ),
      });
    },
  });
  await openFrom(app, "feature");
  expect(popover().textContent).toContain(
    "feature isn't on origin yet. It's checked out in the worktree pin-feature. Switch to that worktree to publish it, then open the pull request.",
  );
  expect(popover().textContent).not.toContain("Check it out");
});

it("publishes nothing from a branch that tracks another branch, as git switch -c topic origin/main leaves it", async () => {
  const app = await mountApp({
    world: onTopic(null, "refs/remotes/origin/main"),
  });
  await app.runPaletteItem("Open pull request…");
  expect(popover().textContent).toContain(
    "topic isn't on origin yet. topic tracks origin/main, so L1 Git can't publish it as topic on origin. Push it there in Git first, then open the pull request.",
  );
  expect(query("button", "Publish and open", popover())).toBeNull();
  const open = button("Open pull request");
  expect(open.getAttribute("aria-disabled")).toBe("true");
  await app.click(open);
  expect(app.bridge.count("preparePublish")).toBe(0);
  expect(app.bridge.count("push")).toBe(0);
  expect(openings(app)).toEqual([]);
});

it("publishes, not pushes, a branch on origin that tracks nothing, as git push origin topic without -u leaves it", async () => {
  const app = await mountApp({
    world: onTopic(C4),
    bridge: (bridge) =>
      bridge.respond("preparePublish", () => ({
        kind: "ready",
        intent: intent("publish"),
      })),
  });
  const openedBefore = pushing(app, {
    kind: "published",
    tracking: { kind: "set" },
  });
  await app.runPaletteItem("Open pull request…");
  expect(popover().textContent).toContain(
    "origin doesn't have 1 commit of topic yet. L1 Git publishes it first, with your Git credentials, then opens the pull request.",
  );
  expect(query("button", "Push and open", popover())).toBeNull();
  await app.click(button("Publish and open"));
  await vi.waitFor(() =>
    expect(openings(app)).toMatchObject([{ head: "topic" }]),
  );
  expect(openedBefore).toEqual([0]);
  expect(
    app.bridge.log.find((request) => request.op === "preparePublish")?.choice,
  ).toEqual({ remote: "origin", destination: "refs/heads/topic" });
});

/** topic checked out and on origin one commit behind, ready to push. */
function readyToPush(world: World) {
  onTopic(C4, TRACKED)(world);
  world.pushes.set(PIN, { kind: "ready", intent: intent("upstream") });
}

it("pushes nothing for an opening the host would refuse anyway", async () => {
  const app = await mountApp({ world: readyToPush });
  pushing(app, { kind: "pushed" });
  await app.runPaletteItem("Open pull request…");
  const pushed = () => app.bridge.count("push");

  await app.type(field("Title"), "x".repeat(257));
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(get("alert", undefined, popover()).textContent).toBe(
      "A pull request needs a title of at most 256 characters. L1 Git pushed nothing and opened no pull request.",
    ),
  );
  await app.type(field("Title"), "Topic work");
  await app.type(field("Description"), "x".repeat(65_537));
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(get("alert", undefined, popover()).textContent).toBe(
      "A description holds at most 65,536 characters. L1 Git pushed nothing and opened no pull request.",
    ),
  );
  await app.type(field("Description"), "");

  const status = app.bridge.world.host.status;
  app.bridge.world.host.status = {
    ...status,
    github:
      status.github.kind === "connected"
        ? { ...status.github, login: "hubot" }
        : status.github,
  };
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(get("alert", undefined, popover()).textContent).toBe(
      "L1 Git is signed in to GitHub as hubot, not octo. L1 Git pushed nothing and opened no pull request.",
    ),
  );
  app.bridge.world.host.status = status;

  app.bridge.world.host.ids.set("octo/pin", "R_other");
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(get("alert", undefined, popover()).textContent).toBe(
      "octo/pin is another repository on GitHub than the one L1 Git read. Open the pull request again. L1 Git pushed nothing and opened no pull request.",
    ),
  );
  expect(pushed(), "no push ran for any of them").toBe(0);
  expect(openings(app)).toEqual([]);

  app.bridge.world.host.ids.delete("octo/pin");
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(openings(app)).toMatchObject([{ title: "Topic work" }]),
  );
  expect(pushed()).toBe(1);
});

it("pushes nothing for a pull request opened from the branch since", async () => {
  const app = await mountApp({ world: readyToPush });
  await app.runPaletteItem("Open pull request…");
  app.bridge.world.host.opens.set("octo/pin", [
    { number: 9, head: "topic", base: "main" },
  ]);
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(popover().textContent).toContain(
      "topic already has pull request #9 open into main.",
    ),
  );
  expect(app.bridge.count("push")).toBe(0);
});

it("pushes nothing when origin pushes somewhere other than the repository on GitHub", async () => {
  const app = await mountApp({
    world: (world) => {
      readyToPush(world);
      world.pushes.set(PIN, {
        kind: "ready",
        intent: {
          ...intent("upstream"),
          endpoint: "https://github.com/hubot/pin.git",
          tracksEndpoint: false,
        },
      });
    },
  });
  await app.runPaletteItem("Open pull request…");
  await app.click(button("Push and open"));
  await vi.waitFor(() =>
    expect(get("alert", undefined, popover()).textContent).toBe(
      "origin pushes to https://github.com/hubot/pin.git, not to where it fetches octo/pin from, so GitHub wouldn't have topic and L1 Git pushed nothing. Push it to octo/pin in Git first. L1 Git opened no pull request.",
    ),
  );
  expect(app.bridge.count("push")).toBe(0);
  expect(openings(app)).toEqual([]);
});

/** Another Git client switches PIN to `other` at the same commit, as
 * `git switch -c other` does, while the popover asks GitHub before its push. */
async function switchedDuringTheLook(app: Harness, label: string) {
  await app.runPaletteItem("Open pull request…");
  const look = app.bridge.hold("openPullContext");
  await app.click(button(label));
  await look.arrived;
  const { world } = app.bridge;
  const snapshot = world.snapshots.get(PIN)!;
  world.snapshots.set(PIN, {
    ...snapshot,
    head: {
      kind: "attached",
      reference: refSchema.parse("refs/heads/other"),
      oid: C6,
    },
  });
  const push = world.pushes.get(PIN);
  if (push?.kind === "ready")
    world.pushes.set(PIN, {
      ...push,
      intent: {
        ...push.intent,
        branch: branchRefSchema.parse("refs/heads/other"),
      },
    });
  look.release();
  await vi.waitFor(() =>
    expect(get("alert", undefined, popover()).textContent).toBe(
      "The worktree has other checked out now, not topic, so L1 Git pushed nothing. Check out topic, then open the pull request again. L1 Git opened no pull request.",
    ),
  );
  expect(app.bridge.count("push")).toBe(0);
  expect(openings(app)).toEqual([]);
}

it("publishes nothing when the worktree switches to another branch at the same commit during the look", async () => {
  const app = await mountApp({
    world: onTopic(null),
    bridge: (bridge) =>
      bridge.respond("preparePublish", (_request, world) => {
        const { head } = world.snapshots.get(PIN)!;
        return {
          kind: "ready",
          intent: {
            ...intent("publish"),
            branch: head.kind === "attached" ? head.reference : null,
          },
        };
      }),
  });
  pushing(app, { kind: "published", tracking: { kind: "set" } });
  await switchedDuringTheLook(app, "Publish and open");
  expect(app.bridge.count("preparePublish")).toBe(1);
});

it("pushes nothing when the worktree switches to another branch at the same commit during the look", async () => {
  const app = await mountApp({ world: readyToPush });
  pushing(app, { kind: "pushed" });
  await switchedDuringTheLook(app, "Push and open");
  expect(app.bridge.count("preparePush")).toBeGreaterThan(0);
});
