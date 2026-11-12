// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  get,
  installHarness,
  mountApp,
  repositoryRow,
} from "./test/appHarness";
import { activeMerge, OTHER, PIN, replayInProgress } from "./test/fixtures";
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
