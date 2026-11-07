import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const contract = JSON.parse(
  readFileSync(
    new URL("./workspace-visual-contract.json", import.meta.url),
    "utf8",
  ),
);
const [repositoryArgument, url = "http://localhost:1423"] =
  process.argv.slice(2);
if (!repositoryArgument)
  throw new Error(
    "Usage: node scripts/verify-workspace-visual.mjs <real-git-repository> [url]",
  );
const repository = realpathSync(repositoryArgument);
const evidence =
  process.env.L1GIT_VISUAL_EVIDENCE ??
  join(tmpdir(), `l1git-visual-${Date.now()}`);
const session = process.env.L1GIT_VISUAL_SESSION ?? "l1git-visual-check";
mkdirSync(evidence, { recursive: true });
function browser(...args) {
  return execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
}
function evaluate(fn, ...args) {
  return JSON.parse(
    browser(
      "eval",
      `(${fn})(${args.map((value) => JSON.stringify(value)).join(",")})`,
    ),
  );
}
const before = execFileSync(
  "git",
  ["-C", repository, "status", "--porcelain=v1"],
  { encoding: "utf8" },
);
browser("set", "viewport", ...contract.viewport.map(String));
browser("open", url);
browser("wait", ".repositories-heading button");
const saved = evaluate(
  (root) =>
    [...document.querySelectorAll(".repository-open")].some(
      (button) => button.title === root,
    ),
  repository,
);
if (!saved) {
  browser("click", ".repositories-heading button");
  browser("wait", "#repository-path");
  browser("fill", "#repository-path", repository);
  browser("click", 'dialog button[type="submit"]');
} else
  browser("click", `.repository-open[title=${JSON.stringify(repository)}]`);
browser("wait", ".history-table tbody tr[aria-rowindex]");
browser("wait", ".commit-information h2");
browser("wait", "file-tree-container");
browser(
  "wait",
  "--fn",
  "document.fonts.status === 'loaded' && document.querySelector('.changes-cell .diffstat') !== null",
);
const report = evaluate((expected) => {
  const failures = [];
  const measured = {};
  for (const [selector, dimensions] of Object.entries(expected.geometry)) {
    const element = document.querySelector(selector);
    if (!element) {
      failures.push(`Missing ${selector}`);
      continue;
    }
    const rect = element.getBoundingClientRect();
    measured[selector] = rect.toJSON();
    for (const [dimension, target] of Object.entries(dimensions))
      if (Math.abs(rect[dimension] - target) > 0.05)
        failures.push(
          `${selector} ${dimension}: ${rect[dimension]} != ${target}`,
        );
  }
  for (const [selector, styles] of Object.entries(expected.styles)) {
    const element = document.querySelector(selector);
    if (!element) {
      failures.push(`Missing ${selector}`);
      continue;
    }
    for (const [property, target] of Object.entries(styles)) {
      const actual = getComputedStyle(element)[property];
      if (actual !== target)
        failures.push(`${selector} ${property}: ${actual} != ${target}`);
    }
  }
  for (const selector of expected.absent)
    if (document.querySelector(selector))
      failures.push(`Rejected control ${selector}`);
  if (
    document.querySelector(".history-scroll").scrollWidth >
    document.querySelector(".history-scroll").clientWidth
  )
    failures.push("History overflows its central pane");
  if (!document.fonts.check('12px "IBM Plex Mono"'))
    failures.push("Mono font is not loaded");
  return { failures, measured };
}, contract);
evaluate(async () => {
  await Promise.all([
    document.fonts.load('400 13px "Inter Variable"'),
    document.fonts.load('500 13px "Inter Variable"'),
    document.fonts.load('600 17px "Inter Variable"'),
    document.fonts.load('400 12px "IBM Plex Mono"'),
  ]);
  await document.fonts.ready;
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  return true;
});
browser("wait", "400");
browser("screenshot", join(evidence, "history-1920.png"));
for (const kind of ["fetch", "pull", "push", "branch", "stash", "more"]) {
  browser("click", `.toolbar-action.${kind}`);
  browser("wait", '[role="menu"] [role="menuitem"]');
  browser("press", "End");
  browser("press", "Escape");
  const returned = evaluate(
    (kind) => document.activeElement?.matches(`.toolbar-action.${kind}`),
    kind,
  );
  if (!returned) report.failures.push(`${kind} did not restore focus`);
}
browser(
  "fill",
  '[aria-label="Filter changed files"]',
  "no-such-file-visual-check",
);
browser("wait", "--text", "No changed files match.");
browser("fill", '[aria-label="Filter changed files"]', "");
browser(
  "wait",
  "--fn",
  "document.querySelector('file-tree-container')?.shadowRoot?.querySelector('[data-type=item]')",
);
for (let depth = 0; depth < 30; depth++) {
  const hasFile = evaluate(
    () =>
      !!document
        .querySelector("file-tree-container")
        ?.shadowRoot?.querySelector("[data-item-type=file]"),
  );
  if (hasFile) break;
  const folder = evaluate(() =>
    document
      .querySelector("file-tree-container")
      .shadowRoot.querySelector('[aria-expanded="false"]')
      .getAttribute("aria-label"),
  );
  browser("find", "role", "treeitem", "click", "--name", folder, "--exact");
}
const file = evaluate(() =>
  document
    .querySelector("file-tree-container")
    .shadowRoot.querySelector("[data-item-type=file]")
    .getAttribute("aria-label"),
);
browser("find", "role", "treeitem", "click", "--name", file, "--exact");
browser("wait", "diffs-container");
browser("find", "role", "button", "click", "--name", "Unified", "--exact");
browser(
  "wait",
  "--fn",
  "document.fonts.status === 'loaded' && document.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]')",
);
const diff = evaluate(() => {
  const host = document.querySelector("diffs-container");
  const line = host.shadowRoot.querySelector("[data-line]");
  const addedText = host.shadowRoot.querySelector(
    '[data-line-type="change-addition"][data-line] span[style]',
  );
  const [unified, split] = document.querySelectorAll(".diff-style button");
  const unifiedRect = unified.getBoundingClientRect();
  const splitRect = split.getBoundingClientRect();
  return {
    lineHeight: getComputedStyle(line).lineHeight,
    controls: [...document.querySelectorAll(".diff-style button")].map(
      (button) => button.textContent,
    ),
    font: getComputedStyle(line).fontFamily,
    addedText: addedText ? getComputedStyle(addedText).color : null,
    unified: {
      x: unifiedRect.x,
      width: unifiedRect.width,
      height: unifiedRect.height,
      gap: splitRect.x - unifiedRect.right,
      radius: getComputedStyle(unified).borderRadius,
      background: getComputedStyle(unified).backgroundColor,
      color: getComputedStyle(unified).color,
    },
  };
});
report.diff = diff;
if (diff.lineHeight !== "28px")
  report.failures.push(`Diff line height ${diff.lineHeight}`);
if (diff.controls.join(",") !== "Unified,Split")
  report.failures.push(`Unexpected diff controls ${diff.controls}`);
if (diff.addedText !== "rgb(197, 228, 210)")
  report.failures.push(`Added diff text ${diff.addedText}`);
for (const [key, expected] of Object.entries({
  x: 1376,
  width: 72,
  height: 28,
  gap: 16,
  radius: "5px",
  background: "rgba(255, 255, 255, 0.08)",
  color: "rgb(189, 189, 189)",
}))
  if (diff.unified[key] !== expected)
    report.failures.push(
      `Diff Unified ${key}: ${diff.unified[key]} != ${expected}`,
    );
browser("wait", "400");
browser("screenshot", join(evidence, "diff-1920.png"));
for (const [width, height] of contract.responsive) {
  browser("set", "viewport", String(width), String(height));
  browser("wait", "400");
  browser("screenshot", join(evidence, `diff-${width}.png`));
}
browser("set", "viewport", ...contract.viewport.map(String));
browser("fill", '[aria-label="Search loaded history"]', "fix");
browser("wait", ".history:not([hidden])");
browser("press", "Escape");
for (const [width, height] of contract.responsive) {
  browser("set", "viewport", String(width), String(height));
  const overflow = evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  if (overflow) report.failures.push(`Page overflow at ${width}`);
  browser("wait", "400");
  browser("screenshot", join(evidence, `history-${width}.png`));
}
const after = execFileSync(
  "git",
  ["-C", repository, "status", "--porcelain=v1"],
  { encoding: "utf8" },
);
if (before !== after)
  report.failures.push("Read-only inspection changed the repository status");
writeFileSync(
  join(evidence, "geometry.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(evidence);
if (report.failures.length) throw new Error(report.failures.join("\n"));
console.log(
  "Workspace geometry, fonts, controls, menus, filtering and responsive checks passed.",
);
