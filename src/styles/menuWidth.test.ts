// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const src = join(process.cwd(), "src");

function loadTheme() {
  const style = document.createElement("style");
  style.textContent = readFileSync(join(src, "theme.css"), "utf8").replace(
    /@import "([^"]+)";/g,
    (_, path: string) => readFileSync(join(src, path), "utf8"),
  );
  document.head.append(style);
}

const widthOf = (className: string) => {
  const menu = document.createElement("div");
  menu.className = className;
  document.body.append(menu);
  return getComputedStyle(menu).width;
};

it("the resolver's More actions menu keeps the width ConflictResolver positions it by, and other menus fit their items", () => {
  loadTheme();
  expect(widthOf("context-menu conflict-menu")).toBe("200px");
  expect(widthOf("context-menu")).toBe("max-content");
});
