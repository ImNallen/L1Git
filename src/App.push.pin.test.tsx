// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { get, installHarness, mountApp, toolbarItem } from "./test/appHarness";
import { PIN, pinOverview } from "./test/fixtures";
import { pushReportSchema } from "./domain/push";
import { overviewSchema } from "./domain/overview";

installHarness();

function mainBehind() {
  const overview = pinOverview();
  return overviewSchema.parse({
    ...overview,
    branches: overview.branches.map((branch) =>
      branch.name === "main"
        ? {
            ...branch,
            state: {
              kind: "behind",
              upstream: "refs/remotes/origin/main",
              target: "e".repeat(40),
              behind: 2,
              blocker: null,
            },
          }
        : branch,
    ),
  });
}

it("disables Push on a behind branch and says why in the menu", async () => {
  const app = await mountApp({
    world: (world) => world.overviews.set(PIN, mainBehind()),
  });
  const item = await toolbarItem(app, "Push", "Push to origin/main");
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.title).toBe(
    "Nothing to push. main is 2 behind origin/main. Pull first.",
  );
  await app.click(item);
  expect(app.bridge.count("push")).toBe(0);
});

it("a rejected push names the diverged branch", async () => {
  const app = await mountApp();
  app.bridge.respond("push", () =>
    pushReportSchema.parse({
      outcome: { kind: "rejected", message: "The remote said no." },
      refresh: { kind: "failed", message: "Not refreshed." },
    }),
  );
  await app.click(await toolbarItem(app, "Push", "Push to origin/main"));
  expect(get("alert", /Push rejected/).textContent).toContain(
    "Push rejected. main has diverged from origin/main (1 ahead, 1 behind). Pull, then push again.",
  );
});
