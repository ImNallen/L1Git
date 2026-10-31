// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettingsSection } from "../actions";
import { useAppearance } from "../appearance";
import { DEFAULT_THEME_SETTINGS } from "../themes/catalog";
import { createUpdatesClient } from "../updates";
import { AppearanceSettings } from "./AppearanceSettings";
import { GeneralSettings } from "./GeneralSettings";
import { SettingsDialog } from "./SettingsDialog";
import { useUpdateRestart } from "./UpdateRestart";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const intervalChanged = vi.fn();

function View() {
  const [open, setOpen] = useState(true);
  const [section, setSection] = useState<SettingsSection>("general");
  const appearance = useAppearance(DEFAULT_THEME_SETTINGS);
  const [client] = useState(() => createUpdatesClient(null));
  const updates = { ...client.read(), ...client };
  const restart = useUpdateRestart(updates);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open settings</button>
      {open && (
        <SettingsDialog
          section={section}
          onSectionChange={setSection}
          onClose={() => setOpen(false)}
        >
          {section === "general" ? (
            <GeneralSettings
              fetching={{
                intervalMinutes: 5,
                onIntervalChange: intervalChanged,
                persistenceError: "Could not save fetch interval",
              }}
              updates={updates}
              restart={restart}
            />
          ) : (
            <AppearanceSettings appearance={appearance} />
          )}
        </SettingsDialog>
      )}
    </>
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  intervalChanged.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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

function heading() {
  const found = container.querySelector("h1");
  if (!found) throw new Error("Missing page heading");
  return found;
}

async function click(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (button) =>
      button.textContent?.trim() === label ||
      button.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  await act(async () => found.click());
}

it("groups Fetching and Updates under one focused General page", async () => {
  expect(container.querySelectorAll(".settings-page")).toHaveLength(1);
  expect(container.querySelectorAll(".settings-content")).toHaveLength(1);
  expect(container.querySelectorAll("h1")).toHaveLength(1);
  expect(heading().textContent).toBe("General");
  expect(document.activeElement).toBe(heading());
  expect(
    [...container.querySelectorAll("h2")].map((item) => item.textContent),
  ).toEqual(["Fetching", "Updates"]);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not save fetch interval",
  );
  expect(
    container.querySelector('[aria-labelledby="updates-heading"]')?.textContent,
  ).toContain("In-app updates are unavailable in the browser preview");
  const interval = container.querySelector<HTMLInputElement>(
    'input[name="fetch-interval"][value="15"]',
  );
  if (!interval) throw new Error("Missing fetch interval");
  await act(async () => interval.click());
  expect(intervalChanged).toHaveBeenCalledExactlyOnceWith(15);
});

it("focuses General after returning from Appearance and reopening the dialog", async () => {
  await click("Appearance");
  expect(heading().textContent).toBe("Appearance");
  expect(document.activeElement).toBe(heading());
  await click("General");
  expect(heading().textContent).toBe("General");
  expect(document.activeElement).toBe(heading());
  await click("Close settings");
  expect(container.querySelector(".settings-dialog")).toBeNull();
  await click("Open settings");
  expect(heading().textContent).toBe("General");
  expect(document.activeElement).toBe(heading());
});

async function search(query: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search settings"]',
  );
  if (!input) throw new Error("Missing settings search");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

function key(target: Element | undefined, value: string) {
  if (!target) throw new Error("Missing keyboard target");
  return act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

it("searches across sections and focuses the destination after mounting", async () => {
  await search("dark mode");
  const result = container.querySelector<HTMLButtonElement>(
    ".settings-search-result",
  );
  expect(result?.textContent).toContain("Color scheme");
  await act(async () => result?.click());
  expect(heading().textContent).toBe("Appearance");
  expect(document.activeElement?.id).toBe("settings-color-scheme");
  expect(container.querySelectorAll(".settings-search-result")).toHaveLength(0);
  await search("fetch");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".settings-search-result")
      ?.click(),
  );
  expect(heading().textContent).toBe("General");
  expect(document.activeElement?.id).toBe("settings-fetch");
  await search("fetch");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".settings-search-result")
      ?.click(),
  );
  expect(document.activeElement?.id).toBe("settings-fetch");
});

it("keeps navigation visible, reports no matches, and clears search", async () => {
  const input = await search("no-such-setting");
  expect(
    container.querySelector(".settings-search-results [role='status']")
      ?.textContent,
  ).toBe("No settings found");
  expect(container.querySelectorAll(".settings-nav-item")).toHaveLength(2);
  await click("Clear settings search");
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);
  expect(container.querySelector(".settings-search-results")).toBeNull();
});

it("navigates search with arrows, Home, End and Enter without intercepting typing", async () => {
  await key(heading(), "/");
  const input = await search("theme");
  expect(document.activeElement).toBe(input);
  await key(input, "/");
  expect(input.value).toBe("theme");
  await key(input, "ArrowDown");
  const buttons = [
    ...container.querySelectorAll<HTMLButtonElement>(".settings-search-result"),
  ];
  expect(document.activeElement).toBe(buttons[0]);
  await key(buttons[0], "End");
  expect(document.activeElement).toBe(buttons.at(-1));
  await key(buttons.at(-1), "ArrowDown");
  expect(document.activeElement).toBe(buttons[0]);
  await key(buttons[0], "ArrowDown");
  expect(document.activeElement).toBe(buttons[1]);
  await key(buttons[1], "Home");
  expect(document.activeElement).toBe(buttons[0]);
  await key(input, "Enter");
  expect(heading().textContent).toBe("Appearance");
  expect(document.activeElement?.id).toBe("themes-heading");
});

it("search destinations preserve the nested theme dialog interaction", async () => {
  await search("import");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".settings-search-result")
      ?.click(),
  );
  expect(document.activeElement?.id).toBe("settings-add-theme");
  await click("Add theme");
  const nested = container.querySelector<HTMLDialogElement>(
    "dialog:not(.settings-dialog)",
  );
  expect(nested?.open).toBe(true);
  await act(async () =>
    nested?.dispatchEvent(new Event("cancel", { cancelable: true })),
  );
  expect(
    container.querySelector<HTMLDialogElement>(".settings-dialog")?.open,
  ).toBe(true);
});
