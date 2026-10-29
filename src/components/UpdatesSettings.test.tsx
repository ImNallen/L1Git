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
function View() {
  const current = useSyncExternalStore(
    client.subscribe,
    client.read,
    client.read,
  );
  return (
    <>
      <UpdatesSettings updates={{ ...current, ...client }} />
      <UpdateAffordance state={current.snapshot.state} onOpen={() => {}} />
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
async function render() {
  await act(async () => reactRoot.render(<View />));
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
  expect(container.textContent).toContain("Update available");
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
  expect(container.textContent).toContain("Update ready to install");
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

it("shows all-root amend-aside loss, preserves cancel, renews changed consent and recovers from native busy", async () => {
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
  await click("Restart and install");
  expect(container.textContent).toContain("3 messages in 2 repositories");
  expect(container.textContent).toContain(inactive);
  expect(container.textContent).toContain("inactive repositories");
  await click("Cancel");
  expect(draftOf(inactive).amend?.draftAside.summary).toBe("Aside");
  await click("Restart and install");
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
});

it("refuses consent while draft-producing tasks run and blocks interaction during accepted install", async () => {
  await state({ kind: "downloaded", candidate, message: null });
  await render();
  let finish: (() => void) | null = null;
  await act(async () => {
    finish = beginDraftTask();
  });
  await click("Restart and install");
  expect(container.textContent).toContain(
    "Commit message work is still finishing",
  );
  expect(container.querySelector("dialog[open]")).toBeNull();
  await act(async () => finish?.());
  await click("Restart and install");
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
  container
    .querySelector("dialog[open]")
    ?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true }),
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
});

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
