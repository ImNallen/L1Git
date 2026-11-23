// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppearance } from "../appearance";
import { DEFAULT_THEME_SETTINGS } from "../themes/catalog";
import { AppearanceSettings } from "./AppearanceSettings";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function View() {
  return (
    <AppearanceSettings appearance={useAppearance(DEFAULT_THEME_SETTINGS)} />
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
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

const panel = () => container.querySelector<HTMLElement>('[role="dialog"]');

function button(name: string) {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === name || b.textContent === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

function field(id: string) {
  const found = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!found) throw new Error(`Missing field ${id}`);
  return found;
}

const click = (name: string) => act(async () => button(name).click());

function type(id: string, value: string) {
  const input = field(id);
  return act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const blur = (id: string) => act(async () => field(id).blur());

function description(input: HTMLInputElement) {
  return (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .flatMap((id) => document.getElementById(id)?.textContent ?? [])
    .join(" ");
}

it("blocks Create theme while a color is not a hex value, and says why", async () => {
  await click("Create theme");
  await type("theme-name", "Aurora");
  await type("theme-color-accent", "#zz12");
  await blur("theme-color-accent");

  const accent = field("theme-color-accent");
  expect(accent.value).toBe("#zz12");
  expect(accent.getAttribute("aria-invalid")).toBe("true");
  expect(description(accent)).toBe("Enter a hex color such as #5b5bd6.");
  expect(panel()?.querySelector("footer .primary")).toHaveProperty(
    "disabled",
    true,
  );

  await type("theme-color-accent", "#5b5bd6");
  expect(description(field("theme-color-accent"))).toBe("");
  expect(panel()?.textContent).not.toContain("Enter a hex color");
  expect(panel()?.querySelector("footer .primary")).toHaveProperty(
    "disabled",
    false,
  );
});

it("edits a saved theme in place", async () => {
  await click("Create theme");
  await type("theme-name", "Aurora");
  await type("theme-color-accent", "#5b5bd6");
  await act(async () =>
    panel()?.querySelector<HTMLButtonElement>("footer .primary")?.click(),
  );
  expect(panel()).toBeNull();

  await click("Edit Aurora");
  expect(panel()?.querySelector("h2")?.textContent).toBe("Edit theme");
  expect(field("theme-name").value).toBe("Aurora");
  expect(field("theme-color-accent").value).toBe("#5b5bd6");

  await type("theme-color-accent", "#e0457b");
  await click("Save");
  expect(panel()).toBeNull();
  expect(
    [...container.querySelectorAll(".theme-card-name")].filter(
      (b) => b.textContent === "Aurora",
    ),
  ).toHaveLength(1);

  await click("Edit Aurora");
  expect(field("theme-color-accent").value).toBe("#e0457b");
});
