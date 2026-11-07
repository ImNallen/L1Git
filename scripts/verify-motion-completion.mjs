import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const session = process.env.L1GIT_VISUAL_SESSION ?? "l1git-motion";
const evidence =
  process.env.L1GIT_VISUAL_EVIDENCE ?? "/tmp/l1git-motion-completion";
const url = process.argv[2] ?? "http://localhost:1431";
const second = process.argv[3];
mkdirSync(evidence, { recursive: true });
const browser = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
const evaluate = (fn) => JSON.parse(browser("eval", `(${fn})()`));
const save = (name, data) =>
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify(data, null, 2));
const changing = (samples, key) => new Set(samples.map((x) => x[key])).size > 3;

browser("open", `${url}/scripts/inspector-motion.html`);
browser("wait", ".changed-files-section");
const inspector = evaluate(async () =>
  (await import("/scripts/inspector-motion.tsx")).verifyInspectorMotion(),
);
save("inspector-regression", inspector);
browser("open", url);
browser("set", "viewport", "1440", "900");
browser("wait", "file-tree-container");
browser("wait", "400");
const tree = evaluate(async () => {
  const root = document.querySelector("file-tree-container").shadowRoot;
  const folder = root.querySelector(
    '[role="treeitem"][aria-level="2"][aria-expanded="true"]',
  );
  folder.click();
  const samples = [];
  const start = performance.now();
  await new Promise((resolve) => {
    function frame() {
      const exits = [
        ...document.querySelectorAll('[data-motion-exit="tree-row"]'),
      ];
      samples.push({
        t: performance.now() - start,
        count: exits.length,
        opacity: exits[0] && getComputedStyle(exits[0]).opacity,
        inert: exits.every(
          (x) => x.inert && x.getAttribute("aria-hidden") === "true",
        ),
        renderer: exits.some((x) => x.querySelector("file-tree-container")),
        unresolvedIcon: exits.some((x) => x.querySelector("svg use")),
      });
      if (performance.now() - start < 300) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  folder.click();
  return samples;
});
save("tree-exits", tree);
assert(
  tree.some((x) => x.count > 0) &&
    changing(
      tree.filter((x) => x.count),
      "opacity",
    ),
  "Removed descendants dissolve over multiple displayed frames",
);
assert(
  tree.every((x) => x.inert && !x.renderer && !x.unresolvedIcon) &&
    tree.at(-1).count === 0,
  "Exit copies are inert and bounded by transition lifetime",
);
browser("wait", "300");
browser("click", ".toolbar-action.more");
browser("wait", "250");
const menu = evaluate(async () => {
  const samples = [];
  document
    .querySelector('[role="menu"]')
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  const start = performance.now();
  await new Promise((resolve) => {
    function frame() {
      const exit = document.querySelector('[data-motion-exit="menu"]');
      samples.push({
        t: performance.now() - start,
        opacity: exit && getComputedStyle(exit).opacity,
        height: exit?.firstElementChild.getBoundingClientRect().height,
        focus: document.activeElement.matches(".toolbar-action.more"),
        live: !!document.querySelector('[role="menu"]'),
      });
      if (performance.now() - start < 230) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  return samples;
});
save("menu-exit", menu);
assert(
  changing(
    menu.filter((x) => x.opacity),
    "opacity",
  ),
  "Menu exit dissolves",
);
assert(
  menu.every((x) => x.focus && !x.live),
  "Menu returns focus immediately and exit is not accessible",
);
const search = evaluate(async () => {
  const input = document.querySelector(".history-search input");
  input.focus();
  await new Promise((r) => setTimeout(r, 150));
  const close = document.querySelector(".history-search .search-close");
  close.click();
  const samples = [];
  const start = performance.now();
  await new Promise((resolve) => {
    function frame() {
      samples.push({
        t: performance.now() - start,
        opacity: getComputedStyle(close).opacity,
        focus: document.activeElement !== input,
      });
      if (performance.now() - start < 180) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  return samples;
});
save("search-exit", search);
assert(
  changing(search, "opacity"),
  "Close search dissolves rather than disappears",
);
assert(search.every((x) => x.focus));
browser(
  "eval",
  "document.querySelector('file-tree-container').shadowRoot.querySelector('[data-item-type=\"file\"]').click()",
);
browser("wait", "diffs-container");
browser("wait", "400");
const horizontal = evaluate(async () => {
  const root = document.querySelector("diffs-container").shadowRoot;
  const buttons = [...document.querySelectorAll(".diff-style button")];
  const click = (name) => buttons.find((x) => x.textContent === name).click();
  click("Split");
  await new Promise((r) => setTimeout(r, 300));
  const codes = [...root.querySelectorAll("[data-code]")];
  codes.forEach((code) => (code.scrollLeft = 80));
  await new Promise((r) => setTimeout(r, 80));
  const offset = Math.max(...codes.map((x) => x.scrollLeft));
  if (offset <= 0)
    throw new Error("Fixture needs horizontally overflowing code");
  const samples = [];
  click("Unified");
  const start = performance.now();
  await new Promise((resolve) => {
    function frame() {
      const line = root.querySelector(
        '[data-line]:not([data-line-type="change-deletion"])',
      );
      const code = root.querySelector("[data-code]");
      samples.push({
        t: performance.now() - start,
        x: line.getBoundingClientRect().x,
        offset: code.scrollLeft,
        max: code.scrollWidth - code.clientWidth,
        preserved: code.dataset.motionScroll,
        animations: line.getAnimations().length,
        exits: document.querySelectorAll('[data-motion-exit="diff-line"]')
          .length,
      });
      if (performance.now() - start < 320) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  return { offset, samples };
});
save("horizontal-diff", horizontal);
assert(changing(horizontal.samples, "x"), "Scrolled code must interpolate");
assert(
  horizontal.samples.some((x) => x.exits > 0),
  "Removed parent column has an exit",
);
assert.equal(
  horizontal.samples.at(-1).offset,
  Math.min(horizontal.offset, horizontal.samples.at(-1).max),
  "Horizontal scroll anchor restored",
);
browser("press", "Escape");
if (second) {
  browser("click", ".repositories-heading button");
  browser("fill", "#repository-path", second);
  browser("click", 'dialog button[type="submit"]');
  browser("wait", "400");
  const repository = evaluate(async () => {
    const buttons = [...document.querySelectorAll(".repository-open")];
    buttons[0].focus();
    buttons[0].click();
    const samples = [];
    const start = performance.now();
    await new Promise((resolve) => {
      function frame() {
        const exits = [
          ...document.querySelectorAll('[data-motion-exit="repository"]'),
        ];
        samples.push({
          t: performance.now() - start,
          exitOpacity: exits[0] && getComputedStyle(exits[0]).opacity,
          count: exits.length,
          incoming: getComputedStyle(document.querySelector(".workspace-panes"))
            .opacity,
          focus: document.activeElement.matches(".repository-open"),
          copies: exits.some((x) =>
            x.querySelector("file-tree-container,diffs-container"),
          ),
        });
        if (performance.now() - start < 500) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
    return samples;
  });
  save("repository-dissolve", repository);
  assert(
    changing(
      repository.filter((x) => x.count),
      "exitOpacity",
    ),
    "Outgoing repository dissolves",
  );
  assert(changing(repository, "incoming"), "Incoming repository dissolves");
  assert(
    repository.every((x) => x.focus && !x.copies),
    "Repository focus and single renderer ownership survive",
  );
}
if (second) {
  const race = evaluate(async () => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return response;
    };
    const buttons = [...document.querySelectorAll(".repository-open")];
    try {
      buttons[1].click();
      await new Promise((resolve) => setTimeout(resolve, 25));
      buttons[0].click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      return {
        selected: document.querySelector(
          ".repository-row.active .repository-open",
        ).title,
        expected: buttons[0].title,
        title: document.querySelector(".commit-information h2")?.textContent,
        exits: document.querySelectorAll("[data-motion-exit]").length,
      };
    } finally {
      window.fetch = original;
    }
  });
  save("repository-race", race);
  assert.equal(race.selected, race.expected);
  assert.equal(race.exits, 0);
  assert(race.title, "Last requested repository has ready inspector content");
}
browser(
  "eval",
  `document.querySelector('file-tree-container').shadowRoot.querySelector('[role="treeitem"][aria-expanded="true"]').click()`,
);
browser("set", "media", "dark", "reduced-motion");
try {
  const reduced = evaluate(async () => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return {
      exits: document.querySelectorAll("[data-motion-exit]").length,
      animations: document
        .getAnimations()
        .filter((animation) => animation.playState === "running").length,
    };
  });
  save("reduced-during-exit", reduced);
  assert.equal(reduced.exits, 0);
  assert.equal(reduced.animations, 0);
} finally {
  browser("set", "media", "dark");
}

console.log(`Completion checks passed. Evidence in ${evidence}`);
