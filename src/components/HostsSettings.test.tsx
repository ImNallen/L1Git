// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Access, GhProbe, HostRequest, HostStatus } from "../domain/host";
import { createHostClient } from "../host";
import { HostsSettings } from "./HostsSettings";

let status: HostStatus;
let probe: GhProbe;
let failures: Map<string, { kind: string; message: string }>;
let sent: HostRequest[];
let client: ReturnType<typeof createHostClient>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const connected = (access: Access = "private"): HostStatus["github"] => ({
  kind: "connected",
  login: "octo",
  api: "https://api.github.com/",
  method: "gh",
  access,
  connectedAt: 1_700_000_000,
});
const row = () =>
  container.querySelector(".settings-row")?.textContent?.replace(/\s+/g, " ");

async function answer(request: HostRequest) {
  sent.push(request);
  const failure = failures.get(request.op);
  if (failure) throw { ...failure, status };
  const github =
    request.op === "connectGh"
      ? connected(probe.kind === "ready" ? probe.access : "private")
      : request.op === "disconnect"
        ? ({ kind: "notConnected", ended: null } as const)
        : null;
  if (github) status = { revision: status.revision + 1, github };
  return {
    op: request.op,
    ...(request.op === "probeGh" ? { data: probe } : {}),
    status,
  };
}

function View() {
  const view = useSyncExternalStore(client.subscribe, client.read, client.read);
  return <HostsSettings host={{ ...view, ...client }} />;
}

async function show(github?: HostStatus["github"]) {
  if (github) {
    status = { revision: 1, github };
    await client.refresh();
  }
  await act(async () => root.render(<View />));
}

const text = () => container.textContent?.replace(/\s+/g, " ") ?? "";
const dialog = () => container.querySelector("dialog[open]");
const ops = () => sent.map((request) => request.op);

function button(label: string) {
  const found = [...container.querySelectorAll("button")].filter(
    (item) => item.textContent?.trim() === label,
  );
  if (found.length !== 1) throw new Error(`${found.length} ${label} buttons`);
  return found[0]!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = { revision: 0, github: { kind: "notConnected", ended: null } };
  probe = {
    kind: "ready",
    login: "octo",
    access: "private",
    path: "/opt/homebrew/bin/gh",
  };
  failures = new Map();
  sent = [];
  client = createHostClient(answer);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows a neutral line with no actions until the first status arrives", async () => {
  await show();
  expect(text()).toContain("Checking the GitHub connection…");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it.each([
  ["revoked", "octo", "GitHub no longer accepts L1 Git's sign-in for @octo."],
  [
    "tokenMissing",
    "octo",
    "L1 Git's sign-in for @octo is no longer in the system keychain.",
  ],
  ["unreadable", null, "L1 Git could not read its saved GitHub connection."],
] as const)(
  "says why a %s connection ended above the sign-in card",
  async (reason, login, sentence) => {
    await show({ kind: "notConnected", ended: { login, reason } });
    expect(text()).toContain(`${sentence}Connect a host to see pull requests`);
    expect(button("Sign in to GitHub")).toBeTruthy();
  },
);

it.each<[GhProbe, string]>([
  [
    { kind: "missing" },
    "L1 Git can't find the GitHub CLI. Install it from cli.github.com, run gh auth login in a terminal, then check again.",
  ],
  [
    { kind: "outdated" },
    "This GitHub CLI is too old for L1 Git to read its sign-in. Update gh, then check again.",
  ],
  [
    { kind: "signedOut" },
    "The GitHub CLI isn't signed in to github.com. Run gh auth login in a terminal, then check again.",
  ],
  [
    { kind: "broken", login: "octo" },
    "The GitHub CLI's sign-in for @octo no longer works. Run gh auth login in a terminal to sign in again, then check again.",
  ],
  [
    { kind: "failed", detail: "gh printed an error." },
    "L1 Git could not read the GitHub CLI's sign-in. gh printed an error.",
  ],
])("the sign-in dialog guides gh in state %o", async (state, guidance) => {
  probe = state;
  await show({ kind: "notConnected", ended: null });
  await click("Sign in to GitHub");
  expect(ops()).toEqual(["status", "probeGh"]);
  expect(dialog()?.textContent?.replace(/\s+/g, " ")).toContain(guidance);
  expect(text()).not.toContain("Sign in as");
  await click("Check again");
  expect(ops()).toEqual(["status", "probeGh", "probeGh"]);
});

it("asks consent for the probed account and connects as that account", async () => {
  probe = {
    kind: "ready",
    login: "hubot",
    access: "publicOnly",
    path: "/opt/homebrew/bin/gh",
  };
  await show({ kind: "notConnected", ended: null });
  await click("Sign in to GitHub");
  const consent = dialog()?.textContent?.replace(/\s+/g, " ");
  expect(consent).toContain(
    "L1 Git will copy the GitHub CLI's sign-in for @hubot into the system keychain. L1 Git only reads from GitHub. Disconnecting later does not sign the GitHub CLI out.",
  );
  expect(consent).toContain("/opt/homebrew/bin/gh");
  expect(consent).toContain("gh auth refresh -h github.com -s repo");
  await click("Sign in as @hubot");
  expect(sent.at(-1)).toEqual({ op: "connectGh", login: "hubot" });
  expect(dialog()).toBeNull();
  expect(row()).toBe(
    "@octogithub.com · Reads public repositories only.Check connectionDisconnect",
  );
});

it("closes on Cancel without copying anything", async () => {
  await show({ kind: "notConnected", ended: null });
  await click("Sign in to GitHub");
  await click("Cancel");
  expect(dialog()).toBeNull();
  expect(ops()).toEqual(["status", "probeGh"]);
});

it("keeps the dialog open with Rust's message when connecting fails", async () => {
  failures.set("connectGh", {
    kind: "ghSignedOut",
    message:
      "The GitHub CLI is no longer signed in to github.com as octo. Run gh auth login, then try again.",
  });
  await show({ kind: "notConnected", ended: null });
  await click("Sign in to GitHub");
  await click("Sign in as @octo");
  expect(dialog()?.querySelector("[role='alert']")?.textContent).toBe(
    "The GitHub CLI is no longer signed in to github.com as octo. Run gh auth login, then try again.",
  );
  expect(container.querySelectorAll("[role='alert']")).toHaveLength(1);
  await click("Cancel");
  expect(container.querySelector("[role='alert']")).toBeNull();
});

it.each([
  ["private", "Reads private and public repositories."],
  ["publicOnly", "Reads public repositories only."],
  ["perRepository", "Reads the repositories this token allows."],
] as const)("names what a %s connection reads", async (access, words) => {
  await show(connected(access));
  expect(row()).toContain(`github.com · ${words}`);
});

it("checks the connection, and disconnects only after confirming", async () => {
  await show(connected());
  await click("Check connection");
  expect(ops()).toEqual(["status", "verify"]);
  await click("Disconnect");
  expect(dialog()?.textContent).toContain(
    "L1 Git will delete its copy of the sign-in for @octo from the system keychain. The GitHub CLI stays signed in.",
  );
  await click("Cancel");
  expect(ops()).toEqual(["status", "verify"]);
  await click("Disconnect");
  await act(async () =>
    dialog()?.querySelector<HTMLButtonElement>(".button.danger")?.click(),
  );
  expect(ops()).toEqual(["status", "verify", "disconnect"]);
  expect(text()).toContain("Connect a host to see pull requests");
});
