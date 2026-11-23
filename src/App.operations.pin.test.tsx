// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { overviewSchema } from "./domain/overview";
import {
  get,
  installHarness,
  mountApp,
  refRow,
  repositoryRow,
} from "./test/appHarness";
import {
  activeMerge,
  C5,
  C6,
  OTHER,
  PIN,
  pinOverview,
  replayInProgress,
} from "./test/fixtures";
import type { RepositoryRoot } from "./domain/repository";

installHarness();

const pill = (root: RepositoryRoot) =>
  repositoryRow(root).querySelector<HTMLElement>(".repository-operation");

it("a repository that is not open shows its merge, and the pill clears on the next window focus", async () => {
  const app = await mountApp({
    world: (world) => world.merges.set(OTHER, activeMerge(OTHER, ["a.txt"])),
  });
  expect(pill(PIN)).toBeNull();
  expect(pill(OTHER)?.textContent).toBe("Merging");
  expect(pill(OTHER)?.title).toBe(
    "A merge is in progress. Open the repository to finish or abort it.",
  );
  expect(
    repositoryRow(OTHER).getAttribute("aria-label"),
    "the pill is part of the row's name",
  ).toBe("other, Merging");

  app.bridge.world.merges.delete(OTHER);
  await app.refocusWindow();
  expect(pill(OTHER)).toBeNull();
  expect(repositoryRow(OTHER).getAttribute("aria-label")).toBeNull();
});

it("a failed probe shows no pill", async () => {
  const app = await mountApp({
    world: (world) => world.merges.set(OTHER, activeMerge(OTHER, ["a.txt"])),
    bridge: (bridge) =>
      bridge.fail(
        "operationProbe",
        { kind: "missingPath", message: "Gone." },
        OTHER,
      ),
  });
  expect(app.bridge.count("operationProbe", OTHER)).toBeGreaterThan(0);
  expect(pill(OTHER)).toBeNull();
});

it("the open repository's pill follows its merge state without waiting for a probe", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN, replayInProgress(PIN, ["notes.txt"])),
  });
  expect(pill(PIN)?.textContent).toBe("Cherry-picking");
  app.bridge.reset();
  await app.click(get("button", "Abort cherry-pick…"));
  await app.click(get("button", "Abort cherry-pick"));
  expect(app.bridge.count("replayAbort")).toBe(1);
  expect(pill(PIN)).toBeNull();
  expect(app.bridge.count("operationProbe")).toBe(0);
});

it("the menu of a branch that is strictly behind fast-forwards only that branch", async () => {
  const topic = {
    reference: "refs/heads/topic",
    name: "topic",
    oid: C6,
    role: "other",
    checkedOutAt: null,
    state: {
      kind: "behind",
      upstream: "refs/remotes/origin/topic",
      target: C5,
      behind: 1,
      blocker: null,
    },
  };
  const app = await mountApp({
    world: (world) =>
      world.overviews.set(
        PIN,
        overviewSchema.parse({
          ...pinOverview(),
          branches: [...pinOverview().branches, topic],
        }),
      ),
  });
  app.bridge.respond("fastForward", () => ({
    outcomes: [
      { kind: "advanced", reference: "refs/heads/topic", from: C6, to: C5 },
    ],
    overview: pinOverview(),
  }));

  await app.contextMenu(refRow("refs/heads/main")!);
  expect(
    get("menuitem", /^Fast-forward to origin\/main/).getAttribute(
      "aria-disabled",
    ),
  ).toBe("true");
  await app.press("Escape");

  await app.contextMenu(refRow("refs/heads/topic")!);
  const item = get("menuitem", "Fast-forward to origin/topic");
  expect(item.getAttribute("aria-disabled")).toBe("false");
  await app.click(item);
  expect(
    app.bridge.log
      .filter((request) => request.op === "fastForward")
      .map((request) => request.advances),
  ).toEqual([[{ reference: "refs/heads/topic", from: C6, to: C5 }]]);
});
