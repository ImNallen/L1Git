// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let closed: ReturnType<typeof vi.fn<(wasOpen: boolean | undefined) => void>>;

function View() {
  const [open, setOpen] = useState(true);
  return open ? (
    <SettingsDialog
      section="appearance"
      onSectionChange={() => {}}
      onClose={() => {
        closed(
          container.querySelector(".settings-dialog")?.hasAttribute("open"),
        );
        setOpen(false);
      }}
    >
      <button>Inside settings</button>
      <dialog aria-label="Nested dialog" />
    </SettingsDialog>
  ) : null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  closed = vi.fn();
  await act(async () =>
    root.render(
      <StrictMode>
        <View />
      </StrictMode>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function shell() {
  const dialog = container.querySelector<HTMLDialogElement>(".settings-dialog");
  if (!dialog) throw new Error("Settings is closed");
  return dialog;
}

it("keeps settings open when nested dialogs cancel or close", async () => {
  const nested = container.querySelector<HTMLDialogElement>(
    'dialog[aria-label="Nested dialog"]',
  );
  if (!nested) throw new Error("Missing nested dialog");
  await act(async () => {
    nested.showModal();
    nested.dispatchEvent(
      new Event("cancel", { bubbles: true, cancelable: true }),
    );
    nested.close();
    nested.dispatchEvent(new Event("close", { bubbles: true }));
  });
  expect(shell().open).toBe(true);
  expect(closed).not.toHaveBeenCalled();
});

it("closes the native shell before returning focus through its caller", async () => {
  const dialog = shell();
  const cancel = new Event("cancel", { cancelable: true });
  await act(async () => dialog.dispatchEvent(cancel));
  expect(cancel.defaultPrevented).toBe(true);
  expect(closed).toHaveBeenCalledExactlyOnceWith(false);
  expect(container.querySelector(".settings-dialog")).toBeNull();
});

it("does not dismiss after a drag from inside onto the backdrop", async () => {
  const inside = container.querySelector("button");
  if (!inside) throw new Error("Missing settings control");
  await act(async () => {
    inside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    shell().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(shell().open).toBe(true);
  expect(closed).not.toHaveBeenCalled();

  await act(async () => {
    shell().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    shell().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(closed).toHaveBeenCalledExactlyOnceWith(false);
});

it("lists General before Appearance and navigates to General", async () => {
  const changed = vi.fn();
  await act(async () =>
    root.render(
      <SettingsDialog
        section="appearance"
        onSectionChange={changed}
        onClose={() => {}}
      >
        <p>Settings content</p>
      </SettingsDialog>,
    ),
  );
  const navigation = [
    ...container.querySelectorAll<HTMLButtonElement>(".settings-nav-item"),
  ];
  expect(navigation.map((button) => button.textContent)).toEqual([
    "General",
    "Appearance",
  ]);
  expect(navigation[1]?.getAttribute("aria-current")).toBe("page");
  await act(async () => navigation[0]?.click());
  expect(changed).toHaveBeenCalledExactlyOnceWith("general");
});

it("leaves slash typing and nested dialog focus alone", async () => {
  const search = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search settings"]',
  );
  const nested = container.querySelector<HTMLDialogElement>(
    'dialog[aria-label="Nested dialog"]',
  );
  if (!search || !nested) throw new Error("Missing settings controls");
  const slash = () =>
    new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
  await act(async () => {
    search.focus();
    const typing = slash();
    search.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
    nested.showModal();
    const button = document.createElement("button");
    button.textContent = "Nested action";
    nested.append(button);
    button.focus();
    const shortcut = slash();
    button.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(button);
  });
});
