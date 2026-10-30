// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUpdatesClient } from "../updates";
import type { UpdateTransport } from "../updates";
import {
  beginDraftTask,
  clearSubmitted,
  draftImpact,
  draftOf,
  setDraft,
} from "../commitDrafts";
import { useUpdateRestart } from "./UpdateRestart";
import { loadMessage } from "../domain/commitMessage";
import { oidSchema, rootSchema } from "../domain/repository";
import {
  InstallingBlocker,
  UpdateAffordance,
  UpdatesSettings,
} from "./UpdatesSettings";

const root = rootSchema.parse("/fixture/current");
const inactive = rootSchema.parse("/fixture/inactive");
const candidate = {
  id: "1",
  version: "0.2.0",
  notes: '<script>alert("notes")</script>',
};
let revision = 0;
const snapshot = (state: unknown) => ({
  revision: ++revision,
  track: "stable",
  installedVersion: "0.1.0",
  preferenceError: null,
  state,
});
let emit: (value: unknown) => void;
let transport: UpdateTransport & {
  invoke: ReturnType<typeof vi.fn<UpdateTransport["invoke"]>>;
};
let client: ReturnType<typeof createUpdatesClient>;
let container: HTMLDivElement;
let reactRoot: ReturnType<typeof createRoot>;
function View({ settings = true }: { settings?: boolean }) {
  const current = useSyncExternalStore(
    client.subscribe,
    client.read,
    client.read,
  );
  const updates = { ...current, ...client };
  const restart = useUpdateRestart(updates);
  return (
    <>
      {settings && <UpdatesSettings updates={updates} restart={restart} />}
      <UpdateAffordance updates={updates} restart={restart} />
      {restart.dialog}
      <InstallingBlocker state={current.snapshot.state} />
    </>
  );
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function state(value: unknown) {
  await act(async () => emit(snapshot(value)));
}
async function render(settings = true) {
  await act(async () => reactRoot.render(<View settings={settings} />));
}
function sidebar() {
  const found = container.querySelector<HTMLButtonElement>(
    ".sidebar-updater button",
  );
  if (!found) throw new Error("Missing sidebar updater");
  return found;
}
async function restartFrom(entry: "settings" | "sidebar") {
  if (entry === "settings") await click("Restart and install");
  else await act(async () => sidebar().click());
}
function confirm() {
  const found = container.querySelector<HTMLButtonElement>(
    "dialog[open] .dialog-actions .primary, dialog[open] .dialog-actions .danger",
  );
  if (!found) throw new Error("Missing restart confirmation");
  return found;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  revision = 0;
  transport = {
    listen: async (accept) => {
      emit = accept;
      return () => {};
    },
    invoke: vi
      .fn<UpdateTransport["invoke"]>()
      .mockResolvedValue(snapshot({ kind: "idle" })),
  };
  client = createUpdatesClient(transport);
  await client.connect();
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});
afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
  clearSubmitted(root, draftOf(root));
  clearSubmitted(inactive, draftOf(inactive));
  vi.unstubAllGlobals();
});

it("separates checking, download, progress and explicit restart and escapes release notes", async () => {
  await render();
  transport.invoke.mockResolvedValue(snapshot({ kind: "checking" }));
  await click("Check for updates");
  expect(container.textContent).toContain("Checking for updates");
  expect(transport.invoke.mock.calls.at(-1)?.[0]).toEqual({
    name: "updater_check",
  });
  await state({ kind: "available", candidate, message: null });
  expect(sidebar().getAttribute("aria-label")).toBe("Download update");
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("pre")?.textContent).toBe(candidate.notes);
  expect(container.textContent).not.toContain("Restart and install");
  transport.invoke.mockResolvedValue(
    snapshot({ kind: "downloading", candidate, received: 10, total: null }),
  );
  await click("Download update");
  expect(container.querySelector("progress")?.hasAttribute("value")).toBe(
    false,
  );
  await state({ kind: "downloading", candidate, received: 20, total: 100 });
  expect(container.querySelector("progress")?.value).toBe(20);
  await state({ kind: "downloaded", candidate, message: null });
  expect(sidebar().getAttribute("aria-label")).toBe("Restart and install");
  await click("Restart and install");
  expect(container.querySelector("dialog[open]")?.textContent).toContain(
    "no unsaved commit drafts",
  );
  expect(
    transport.invoke.mock.calls.some(
      ([command]) => command.name === "updater_install",
    ),
  ).toBe(false);
  await click("Cancel");
  expect(draftImpact().frozen).toBe(false);
});

it.each(["settings", "sidebar"] as const)(
  "%s shows all-root amend-aside loss, preserves cancel, renews changed consent and recovers from native busy",
  async (entry) => {
    setDraft(root, {
      draft: { summary: "Visible draft", description: "" },
      amend: null,
    });
    setDraft(inactive, {
      draft: { summary: "Amending", description: "" },
      amend: {
        draftAside: { summary: "Aside", description: "" },
        head: oidSchema.parse("a".repeat(40)),
        loaded: loadMessage("Amending"),
      },
    });
    await state({ kind: "downloaded", candidate, message: null });
    await render();
    await restartFrom(entry);
    expect(container.textContent).toContain("3 messages in 2 repositories");
    expect(container.textContent).toContain(inactive);
    expect(container.textContent).toContain("inactive repositories");
    await click("Cancel");
    expect(draftOf(inactive).amend?.draftAside.summary).toBe("Aside");
    await restartFrom(entry);
    await act(async () =>
      setDraft(root, {
        draft: { summary: "Changed", description: "" },
        amend: null,
      }),
    );
    await click("Discard drafts and restart");
    expect(container.textContent).toContain("Your drafts changed");
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    transport.invoke.mockResolvedValue(
      snapshot({
        kind: "downloaded",
        candidate,
        message: "Repository work is still running.",
      }),
    );
    await click("Discard drafts and restart");
    expect(container.textContent).toContain("Repository work is still running");
    expect(container.querySelector("dialog[open]")).toBeNull();
    expect(draftImpact().frozen).toBe(false);
    expect(draftOf(root).draft.summary).toBe("Changed");
    expect(draftOf(inactive).amend?.draftAside.summary).toBe("Aside");
  },
);

it.each(["settings", "sidebar"] as const)(
  "%s refuses consent while draft-producing tasks run and blocks interaction during accepted install",
  async (entry) => {
    await state({ kind: "downloaded", candidate, message: null });
    await render();
    let finish: (() => void) | null = null;
    await act(async () => {
      finish = beginDraftTask();
    });
    await restartFrom(entry);
    expect(container.textContent).toContain(
      "Commit message work is still finishing",
    );
    expect(container.querySelector("dialog[open]")).toBeNull();
    await act(async () => finish?.());
    await restartFrom(entry);
    transport.invoke.mockResolvedValue(
      snapshot({ kind: "installing", candidate }),
    );
    const confirm = [...container.querySelectorAll("dialog button")].find(
      (item) => item.textContent === "Restart and install",
    );
    if (!(confirm instanceof HTMLButtonElement))
      throw new Error("Missing confirm");
    await act(async () => confirm.click());
    expect(draftImpact().frozen).toBe(true);
    const globalKey = vi.fn();
    window.addEventListener("keydown", globalKey);
    container.querySelector("dialog[open]")?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "o",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    expect(globalKey).not.toHaveBeenCalled();
    window.removeEventListener("keydown", globalKey);
    expect(container.querySelector("dialog[open]")?.textContent).toContain(
      "Please wait",
    );
    const cancel = new Event("cancel", { cancelable: true });
    container.querySelector("dialog[open]")?.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    await state({
      kind: "downloaded",
      candidate,
      message: "Installation failed",
    });
    expect(draftImpact().frozen).toBe(false);
  },
);

it("shows manual update guidance on browser, dev and non-AppImage Linux and a retry for check failures", async () => {
  await render();
  for (const [reason, text] of [
    ["browser", "browser preview"],
    ["development", "development builds"],
    ["manualLinux", "package manager"],
  ]) {
    await state({ kind: "unavailable", reason });
    expect(container.textContent).toContain(text);
    expect(button("Check for updates").disabled).toBe(true);
    expect(container.querySelector("a")?.href).toBe(
      "https://github.com/ImNallen/L1Git/releases",
    );
  }
  await state({ kind: "failed", message: "Could not reach update server" });
  expect(button("Retry check").disabled).toBe(false);
  expect(container.textContent).toContain("Could not reach update server");
});

it("checks, downloads and confirms from the sidebar without mounting Settings", async () => {
  await render(false);
  expect(sidebar().getAttribute("aria-label")).toBe("Check for updates");
  expect(sidebar().textContent).toBe("");
  expect(sidebar().disabled).toBe(false);
  transport.invoke.mockResolvedValue(snapshot({ kind: "checking" }));
  await act(async () => sidebar().click());
  expect(transport.invoke.mock.calls.at(-1)?.[0]).toEqual({
    name: "updater_check",
  });
  expect(sidebar().disabled).toBe(true);
  await state({ kind: "available", candidate, message: null });
  expect(sidebar().getAttribute("aria-label")).toBe("Download update");
  transport.invoke.mockResolvedValue(
    snapshot({ kind: "downloading", candidate, received: 0, total: null }),
  );
  await act(async () => sidebar().click());
  expect(transport.invoke.mock.calls.at(-1)?.[0]).toEqual({
    name: "updater_download",
    args: { candidate: candidate.id },
  });
  await state({ kind: "downloaded", candidate, message: null });
  await act(async () => sidebar().click());
  expect(
    container.querySelectorAll('dialog[aria-labelledby="restart-title"]'),
  ).toHaveLength(1);
  expect(
    container.querySelector('[aria-labelledby="updates-heading"]'),
  ).toBeNull();
  expect(
    transport.invoke.mock.calls.filter(
      ([command]) => command.name === "updater_install",
    ),
  ).toHaveLength(0);
  transport.invoke.mockResolvedValue(
    snapshot({ kind: "installing", candidate }),
  );
  await act(async () => confirm().click());
  expect(transport.invoke.mock.calls.at(-1)?.[0]).toEqual({
    name: "updater_install",
    args: { candidate: candidate.id },
  });
  expect(sidebar().disabled).toBe(true);
  expect(sidebar().getAttribute("aria-label")).toBe("Installing update…");
  await state({
    kind: "downloaded",
    candidate,
    message: "Installation failed",
  });
});

it("keeps the sidebar available for current and failed checks and disables every busy or unavailable state", async () => {
  await render(false);
  for (const value of [{ kind: "idle" }, { kind: "current" }]) {
    await state(value);
    expect(sidebar().disabled).toBe(false);
    expect(sidebar().getAttribute("aria-label")).toBe("Check for updates");
  }
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "No newer Stable release",
  );
  await state({ kind: "failed", message: "Server is offline" });
  expect(sidebar().getAttribute("aria-label")).toBe("Retry check");
  expect(sidebar().disabled).toBe(false);
  expect(container.querySelector(".update-tooltip")?.textContent).toContain(
    "Server is offline",
  );
  expect(sidebar().getAttribute("aria-describedby")).toBe(
    container.querySelector('[role="status"]')?.id,
  );
  transport.invoke.mockResolvedValue(snapshot({ kind: "checking" }));
  await act(async () => sidebar().click());
  expect(transport.invoke.mock.calls.at(-1)?.[0]).toEqual({
    name: "updater_check",
  });
  for (const value of [
    { kind: "checking" },
    { kind: "downloading", candidate, received: 12, total: null },
    { kind: "installing", candidate },
  ]) {
    await state(value);
    expect(sidebar().disabled).toBe(true);
    expect(sidebar().querySelector(".spin")).not.toBeNull();
    const calls = transport.invoke.mock.calls.length;
    await act(async () => sidebar().click());
    expect(transport.invoke).toHaveBeenCalledTimes(calls);
  }
  for (const [reason, guidance] of [
    ["browser", "browser preview"],
    ["development", "development builds"],
    ["manualLinux", "package manager"],
    ["unsupported", "this platform"],
  ]) {
    await state({ kind: "unavailable", reason });
    expect(sidebar().disabled).toBe(true);
    expect(sidebar().querySelector(".spin")).toBeNull();
    const wrapper = sidebar().parentElement;
    expect(wrapper?.tabIndex).toBe(0);
    wrapper?.focus();
    expect(document.activeElement).toBe(wrapper);
    expect(wrapper?.querySelector(".update-tooltip")?.textContent).toContain(
      guidance,
    );
    const calls = transport.invoke.mock.calls.length;
    await act(async () => sidebar().click());
    expect(transport.invoke).toHaveBeenCalledTimes(calls);
  }
});

it("announces known-total percent and indeterminate progress from the sidebar", async () => {
  await render(false);
  await state({ kind: "downloading", candidate, received: 12, total: 100 });
  expect(sidebar().getAttribute("aria-label")).toBe("Downloading update… 12%");
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "12%",
  );
  expect(sidebar().disabled).toBe(true);
  await state({ kind: "downloading", candidate, received: 12, total: null });
  expect(sidebar().getAttribute("aria-label")).toBe("Downloading update…");
  expect(sidebar().querySelector(".spin")).not.toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).not.toContain(
    "%",
  );
});

it("exposes download, install, preference and transport errors without opening Settings", async () => {
  await render(false);
  for (const kind of ["available", "downloaded"]) {
    await state({ kind, candidate, message: "Artifact could not be saved" });
    expect(container.querySelector(".update-tooltip")?.textContent).toContain(
      "Artifact could not be saved",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Artifact could not be saved",
    );
    sidebar().focus();
    expect(document.activeElement).toBe(sidebar());
  }
  await state({ kind: "available", candidate, message: "Download failed" });
  expect(sidebar().getAttribute("aria-label")).toBe("Retry download");
  transport.invoke.mockResolvedValue(
    snapshot({ kind: "downloading", candidate, received: 0, total: null }),
  );
  await act(async () => sidebar().click());
  expect(transport.invoke.mock.calls.at(-1)?.[0]).toEqual({
    name: "updater_download",
    args: { candidate: candidate.id },
  });
  await act(async () =>
    emit({
      ...snapshot({ kind: "idle" }),
      preferenceError: "Channel could not be saved",
    }),
  );
  expect(container.querySelector(".update-tooltip")?.textContent).toContain(
    "Channel could not be saved",
  );
  await state({ kind: "idle" });
  transport.invoke.mockRejectedValue("Updater connection failed");
  await act(async () => sidebar().click());
  expect(container.querySelector(".update-tooltip")?.textContent).toContain(
    "Updater connection failed",
  );
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Updater connection failed",
  );
});

it.each(["settings", "sidebar"] as const)(
  "%s closes consent when the downloaded candidate changes or is no longer downloaded",
  async (entry) => {
    await state({ kind: "downloaded", candidate, message: null });
    await render();
    await restartFrom(entry);
    const staleConfirm = confirm();
    await state({
      kind: "downloaded",
      candidate: { ...candidate, id: "2" },
      message: null,
    });
    expect(container.querySelector("dialog[open]")).toBeNull();
    await act(async () => staleConfirm.click());
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    await restartFrom(entry);
    expect(container.querySelector("dialog[open]")).not.toBeNull();
    await state({ kind: "checking" });
    expect(container.querySelector("dialog[open]")).toBeNull();
    await state({ kind: "downloaded", candidate, message: null });
    expect(container.querySelector("dialog[open]")).toBeNull();
  },
);

it.each(["settings", "sidebar"] as const)(
  "%s sends one install command while confirmation is pending and recovers after rejection",
  async (entry) => {
    await state({ kind: "downloaded", candidate, message: null });
    await render();
    await restartFrom(entry);
    let rejectInstall: (reason: string) => void = () => {};
    transport.invoke.mockReturnValueOnce(
      new Promise<unknown>((_, reject) => {
        rejectInstall = reject;
      }),
    );
    const install = confirm();
    await act(async () => {
      install.click();
      install.click();
    });
    expect(install.disabled).toBe(true);
    expect(draftImpact().frozen).toBe(true);
    expect(
      transport.invoke.mock.calls.filter(
        ([command]) => command.name === "updater_install",
      ),
    ).toHaveLength(1);
    await act(async () => rejectInstall("Install command failed"));
    expect(container.querySelector("dialog[open]")).toBeNull();
    expect(draftImpact().frozen).toBe(false);
    expect(container.querySelector(".update-tooltip")?.textContent).toContain(
      "Install command failed",
    );
    await restartFrom(entry);
    expect(confirm().disabled).toBe(false);
    await click("Cancel");
  },
);

it.each(["settings", "sidebar"] as const)(
  "%s disables open consent while a draft task runs and preserves Escape cancellation",
  async (entry) => {
    await state({ kind: "downloaded", candidate, message: null });
    await render();
    await restartFrom(entry);
    let finish: (() => void) | null = null;
    await act(async () => {
      finish = beginDraftTask();
    });
    expect(confirm().disabled).toBe(true);
    await act(async () => confirm().click());
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    const cancel = new Event("cancel", { cancelable: true });
    await act(async () =>
      container.querySelector("dialog[open]")?.dispatchEvent(cancel),
    );
    expect(cancel.defaultPrevented).toBe(true);
    expect(container.querySelector("dialog[open]")).toBeNull();
    expect(draftImpact().frozen).toBe(false);
    await act(async () => finish?.());
  },
);
