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
