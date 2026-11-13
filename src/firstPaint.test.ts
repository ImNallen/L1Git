// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeAppearance } from "./appearance";

const firstPaint = readFileSync(
  join(process.cwd(), "public/first-paint.js"),
  "utf8",
);

function systemPrefersDark(dark: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: dark && query === "(prefers-color-scheme: dark)",
    addEventListener() {},
    removeEventListener() {},
  }));
}

function paintedRoot() {
  const root = document.documentElement;
  return {
    theme: root.dataset.theme,
    palette: root.hasAttribute("data-palette"),
    style: root.style.cssText,
  };
}

function clearRoot() {
  const root = document.documentElement;
  delete root.dataset.theme;
  root.removeAttribute("data-palette");
  root.removeAttribute("style");
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  clearRoot();
});

it.each([
  ["a pinned light theme on a dark system", true, "light", "grove-light"],
  ["a pinned dark theme on a light system", false, "dark", "l1-dark"],
  ["the system scheme on a dark system", true, "system", "grove-light"],
  ["the system scheme on a light system", false, "system", "grove-light"],
])(
  "the first paint matches the app's paint for %s",
  (_, dark, colorScheme, lightTheme) => {
    systemPrefersDark(dark);
    localStorage.setItem(
      "l1git.appearance",
      JSON.stringify({ colorScheme, lightTheme, darkTheme: "l1-dark" }),
    );
    initializeAppearance();
    const app = paintedRoot();
    clearRoot();
    new Function(firstPaint)();
    expect(paintedRoot()).toEqual(app);
  },
);

it("the first paint follows the system before the app has ever run", () => {
  systemPrefersDark(false);
  new Function(firstPaint)();
  expect(paintedRoot().theme).toBe("light");
});
