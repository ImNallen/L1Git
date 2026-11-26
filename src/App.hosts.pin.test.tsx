// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  dialogs,
  get,
  installHarness,
  mountApp,
  query,
} from "./test/appHarness";

installHarness();

const github = () => get("region", "GitHub").textContent;

it("asks Rust for the host status once on launch, and nothing more", async () => {
  const app = await mountApp();
  expect(app.bridge.hostLog).toEqual([{ op: "status" }]);
});

it("signs in to GitHub from Settings › Hosts and disconnects again", async () => {
  const app = await mountApp();
  await app.runPaletteItem("Open Hosts settings");
  expect(dialogs()).toEqual(["Settings"]);
  expect(github()).toContain("Connect a host to see pull requests");

  await app.click(get("button", "Sign in to GitHub"));
  expect(dialogs()).toEqual(["Settings", "Sign in to GitHub"]);
  expect(get("dialog", "Sign in to GitHub").textContent).toContain(
    "/opt/homebrew/bin/gh",
  );
  await app.click(get("button", "Sign in as @octo"));
  expect(dialogs()).toEqual(["Settings"]);
  expect(github()).toContain(
    "@octogithub.com · Private and public repositories.",
  );
  expect(app.bridge.hostLog).toEqual([
    { op: "status" },
    { op: "probeGh" },
    { op: "connectGh", login: "octo" },
  ]);

  await app.click(get("button", "Check connection"));
  await app.click(get("button", "Disconnect"));
  expect(dialogs()).toEqual(["Settings", "Disconnect GitHub?"]);
  await app.click(
    get("button", "Disconnect", query("dialog", "Disconnect GitHub?")!),
  );
  expect(github()).toContain("Connect a host to see pull requests");
  expect(app.bridge.hostLog.slice(3)).toEqual([
    { op: "verify" },
    { op: "disconnect" },
  ]);
});

it("finds GitHub in settings search under Hosts", async () => {
  const app = await mountApp();
  await app.runPaletteItem("Open Settings");
  await app.type(get("textbox", "Search settings"), "github");
  const result = get("button", /^GitHub/);
  expect(result.textContent).toBe(
    "GitHubHosts · Sign in to read pull requests.",
  );
  await app.click(result);
  expect(get("region", "Hosts")).toBeTruthy();
  expect(document.activeElement?.id).toBe("settings-github");
});
