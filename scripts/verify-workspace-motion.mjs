import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const session = process.env.L1GIT_VISUAL_SESSION ?? "l1git-motion";
const evidence = process.env.L1GIT_VISUAL_EVIDENCE ?? "/tmp/l1git-motion";
mkdirSync(evidence, { recursive: true });
const browser = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
const evaluate = (fn) => JSON.parse(browser("eval", `(${fn})()`));
const save = (name, data) =>
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify(data, null, 2));
const changing = (samples, property) =>
  new Set(samples.map((x) => x[property])).size > 3;
browser("set", "viewport", "1920", "960");
browser("set", "media", "dark");
if (evaluate(() => !!document.querySelector(".file-diff")))
  browser("press", "Escape");
for (const [selector, control] of [
  [".sidebar", "Toggle sidebar"],
  [".inspector", "Toggle commit inspector"],
]) {
  if (
    JSON.parse(
      browser("eval", `!document.querySelector(${JSON.stringify(selector)})`),
    )
  )
    browser("click", `[aria-label="${control}"]`);
}
browser("wait", "file-tree-container");
const sections = evaluate(async () => {
  const toggle = document.querySelector(".tree-section");
  const body = toggle.nextElementSibling;
  const start = performance.now();
  toggle.click();
  const samples = [];
  await new Promise((resolve) => {
    function frame() {
      samples.push({
        t: performance.now() - start,
        height: body.getBoundingClientRect().height,
        inert: body.inert,
        rotation: getComputedStyle(toggle.querySelector("svg")).transform,
      });
      if (performance.now() - start < 300) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  toggle.focus();
  toggle.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  return samples;
});
save("section", sections);
assert(changing(sections, "height"), "Section height must interpolate");
assert(changing(sections, "rotation"), "Chevron must rotate");

const tree = evaluate(async () => {
  const root = document.querySelector("file-tree-container").shadowRoot;
  const folders = [
    ...root.querySelectorAll('[role="treeitem"][aria-expanded="true"]'),
  ];
  const folder = folders.find((x) => x.getAttribute("aria-level") === "2");
  if (!folder)
    throw new Error("Choose a commit with nested folders and following rows");
  const path = folder.dataset.itemPath;
  const rows = [...root.querySelectorAll('[role="treeitem"]')];
  const following = rows
    .slice(rows.indexOf(folder) + 1)
    .find((x) => !x.dataset.itemPath.startsWith(path));
  if (!following) throw new Error("Fixture needs a following row");
  const followingPath = following.dataset.itemPath;
  const samples = [];
  const start = performance.now();
  folder.focus();
  folder.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      composed: true,
    }),
  );
  await new Promise((resolve) => {
    function frame() {
      const row = [...root.querySelectorAll('[role="treeitem"]')].find(
        (x) => x.dataset.itemPath === followingPath,
      );
      samples.push({
        t: performance.now() - start,
        y: row.getBoundingClientRect().y,
        translate: getComputedStyle(row).translate,
        focus: root.activeElement?.dataset.itemPath,
      });
      if (performance.now() - start < 280) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  folder.click();
  return samples;
});
save("tree", tree);
assert(changing(tree, "y"), "Mounted following rows must move");
assert(
  tree.every((x) => x.focus === tree[0].focus),
  "Tree keyboard focus must survive collapse",
);
browser("wait", "300");

const menu = evaluate(async () => {
  const start = performance.now();
  document.querySelector(".toolbar-action.more").click();
  const samples = [];
  await new Promise((resolve) => {
    function frame() {
      const menu = document.querySelector('[role="menu"]');
      samples.push({
        t: performance.now() - start,
        height: menu.getBoundingClientRect().height,
        opacity: getComputedStyle(menu).opacity,
        translate: getComputedStyle(menu.querySelector('[role="menuitem"]'))
          .translate,
      });
      if (performance.now() - start < 230) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  return samples;
});
save("menu", menu);
assert(
  changing(menu, "height") && changing(menu, "translate"),
  "Menu and actions must interpolate",
);
browser("press", "Escape");
assert(
  evaluate(() => document.activeElement.matches(".toolbar-action.more")),
  "Menu returns focus",
);

const opening = evaluate(async () => {
  const samples = [];
  const start = performance.now();
  document
    .querySelector("file-tree-container")
    .shadowRoot.querySelector('[data-item-type="file"]')
    .click();
  await new Promise((resolve) => {
    function frame() {
      const history = document.querySelector(".history");
      const diff = document.querySelector(".file-diff");
      samples.push({
        t: performance.now() - start,
        historyY: history.getBoundingClientRect().y,
        historyOpacity: getComputedStyle(history).opacity,
        diffOpacity: diff && getComputedStyle(diff).opacity,
      });
      if (performance.now() - start < 400) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  return samples;
});
save("open-diff", opening);
assert(
  changing(opening, "historyY"),
  "Outgoing history moves while diff enters",
);
browser("wait", "diffs-container");
if (
  evaluate(
    () =>
      [...document.querySelectorAll(".diff-style button")]
        .find((x) => x.textContent === "Split")
        .getAttribute("aria-pressed") === "true",
  )
) {
  browser("click", ".diff-style button:first-child");
  browser("wait", "300");
}
const split = evaluate(async () => {
  const samples = [];
  const start = performance.now();
  [...document.querySelectorAll(".diff-style button")]
    .find((x) => x.textContent === "Split")
    .click();
  await new Promise((resolve) => {
    function frame() {
      const root = document.querySelector("diffs-container").shadowRoot;
      const line =
        root.querySelector("[data-additions] [data-line]") ??
        root.querySelector("[data-line]");
      samples.push({
        t: performance.now() - start,
        x: line.getBoundingClientRect().x,
        translate: getComputedStyle(line).translate,
        overflow: getComputedStyle(line.closest("[data-code]")).overflow,
        active: document.activeElement.textContent,
      });
      if (performance.now() - start < 300) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  return samples;
});
save("split", split);
assert(
  split.every(
    (x) =>
      x.x >= Math.min(split[0].x, split.at(-1).x) - 1 &&
      x.x <= Math.max(split[0].x, split.at(-1).x) + 1,
  ),
  "Code lines must stay between their endpoint columns",
);
assert(
  changing(split, "x"),
  "Real code lines must relocate to the split column",
);
assert(
  split.some((x) => x.overflow === "visible"),
  "Moving lines must not be clipped by column containment",
);
assert(
  !evaluate(() => !!document.querySelector("[data-layout-motion]")),
  "Column clipping must be restored",
);

const reversal = evaluate(async () => {
  const buttons = [...document.querySelectorAll(".diff-style button")];
  const click = (name) => buttons.find((x) => x.textContent === name).click();
  click("Unified");
  await new Promise((r) => setTimeout(r, 65));
  const line = () => {
    const root = document.querySelector("diffs-container").shadowRoot;
    return (
      root.querySelector("[data-additions] [data-line]") ??
      root.querySelector("[data-line]")
    );
  };
  const before = line().getBoundingClientRect().x;
  click("Split");
  await new Promise((r) => requestAnimationFrame(r));
  const after = line().getBoundingClientRect().x;
  await new Promise((r) => setTimeout(r, 300));
  return {
    before,
    after,
    final: line().getBoundingClientRect().x,
    active: buttons.find((x) => x.getAttribute("aria-pressed") === "true")
      .textContent,
  };
});
save("reversal", reversal);
assert(
  reversal.before > split[0].x + 10 && reversal.before < split.at(-1).x - 10,
  "Reverse from an interpolated position, not a settled endpoint",
);
assert(
  Math.abs(reversal.before - reversal.after) < 100,
  "Reversal must begin near the displayed position",
);
assert.equal(reversal.active, "Split");
browser("screenshot", `${evidence}/split-rest.png`);
browser("set", "media", "dark", "reduced-motion");
const reduced = evaluate(async () => {
  [...document.querySelectorAll(".diff-style button")]
    .find((x) => x.textContent === "Unified")
    .click();
  await new Promise((r) => requestAnimationFrame(r));
  const root = document.querySelector("diffs-container").shadowRoot;
  return {
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    animations: [...root.querySelectorAll("[data-line]")].flatMap((x) =>
      x.getAnimations(),
    ).length,
  };
});
save("reduced", reduced);
assert(
  reduced.reduced && reduced.animations === 0,
  "Reduced motion must skip layout animations",
);
browser("set", "media", "dark");
browser("press", "Escape");
console.log(`Motion checks passed. Evidence in ${evidence}`);
