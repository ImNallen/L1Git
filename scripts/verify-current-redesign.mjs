import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [repositoryArgument, url = "http://localhost:1423", output] =
  process.argv.slice(2);
if (!repositoryArgument)
  throw new Error(
    "Usage: node scripts/verify-current-redesign.mjs <repository> [url] [output]",
  );
const repository = realpathSync(repositoryArgument);
const directory = output ?? join(tmpdir(), `l1git-redesign-${Date.now()}`);
const contract = JSON.parse(
  readFileSync(
    new URL("./redesign-visual-contract.json", import.meta.url),
    "utf8",
  ),
);
const session = `l1git-redesign-${process.pid}`;
mkdirSync(directory, { recursive: true });
const browser = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
const evaluate = (expression) => JSON.parse(browser("eval", expression));
const git = (...args) =>
  execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
const repositoryState = () => ({
  head: git("rev-parse", "HEAD"),
  refs: git("for-each-ref", "refs/heads", "refs/remotes"),
  status: git("status", "--porcelain=v1"),
});
const before = repositoryState();
const report = { repository, before, failures: [], screens: [], geometry: {} };
const settled = () =>
  browser(
    "wait",
    "--fn",
    "document.fonts.status === 'loaded' && [...document.getAnimations(), ...[...document.querySelectorAll('file-tree-container, diffs-container')].flatMap(e => e.shadowRoot?.getAnimations() ?? [])].every(a => a.playState !== 'running')",
  );
const capture = (name) => {
  settled();
  browser("screenshot", join(directory, `${name}.png`));
  report.screens.push(name);
};
try {
  browser("set", "viewport", ...contract.viewport.map(String));
  browser("open", url);
  browser("click", 'button[aria-label="Add repository"]');
  browser("click", '[role="option"]:first-child');
  browser("wait", 'input[aria-label="Path"]');
  browser("fill", 'input[aria-label="Path"]', repository);
  browser(
    "wait",
    "--fn",
    "!document.querySelector('dialog button[type=submit]').disabled",
  );
  browser("click", 'dialog button[type="submit"]');
  browser("wait", ".commit-information h2");
  browser(
    "wait",
    "--fn",
    "!!document.querySelector('.changes-cell .diffstat')",
  );
  settled();
  const measured = evaluate(`(() => {
    const contract = ${JSON.stringify(contract)};
    const failures = [], geometry = {};
    for (const [selector, expected] of Object.entries(contract.geometry)) {
      const element = document.querySelector(selector);
      if (!element) { failures.push('Missing ' + selector); continue; }
      const rect = element.getBoundingClientRect().toJSON(); geometry[selector] = rect;
      for (const [key, value] of Object.entries(expected)) if (Math.abs(rect[key] - value) > 0.05) failures.push(selector + ' ' + key + ': ' + rect[key] + ' != ' + value);
    }
    for (const [selector, expected] of Object.entries(contract.styles)) {
      const element = document.querySelector(selector);
      if (!element) { failures.push('Missing ' + selector); continue; }
      const style = getComputedStyle(element);
      for (const [key, value] of Object.entries(expected)) if (style[key] !== value) failures.push(selector + ' ' + key + ': ' + style[key] + ' != ' + value);
    }
    return {failures, geometry};
  })()`);
  report.failures.push(...measured.failures);
  report.geometry = measured.geometry;
  capture("history-1920");
  browser(
    "fill",
    '[aria-label="Filter repositories and refs"]',
    "redesign-no-such-branch",
  );
  browser("wait", "--text", "No repositories or branches match.");
  browser("press", "Escape");
  assert.ok(evaluate("document.activeElement.matches('.repository-open')"));
  browser(
    "fill",
    '[aria-label="Search loaded history"]',
    "redesign-no-such-commit",
  );
  browser("wait", ".history-search-count");
  assert.ok(
    evaluate(
      "document.querySelector('.history-search-count').textContent === 'No matches'",
    ),
  );
  browser("press", "Escape");
  browser("wait", ".commit-information h2");
  browser(
    "fill",
    '[aria-label="Filter changed files"]',
    "redesign-no-such-file",
  );
  browser("wait", "--text", "No changed files match.");
  browser("fill", '[aria-label="Filter changed files"]', "");
  browser(
    "wait",
    "--fn",
    "!!document.querySelector('file-tree-container')?.shadowRoot?.querySelector('[data-type=item]')",
  );
  let fileRef;
  const accessibleName = (name) => name.replace(/\s+/g, " ").trim();
  for (let depth = 0; depth < 30; depth++) {
    settled();
    const snapshot = browser("snapshot", "-i").split("\n");
    writeFileSync(
      join(directory, `file-tree-${depth}.txt`),
      snapshot.join("\n"),
    );
    const names = evaluate(
      "[...document.querySelector('file-tree-container').shadowRoot.querySelectorAll('[data-item-type=file]')].map(e=>e.getAttribute('aria-label'))",
    );
    const fileRow = snapshot.find((line) =>
      names.some((name) =>
        line.includes(`treeitem ${JSON.stringify(accessibleName(name))} `),
      ),
    );
    fileRef = fileRow?.match(/\bref=(\w+)/)?.[1];
    if (fileRef) break;
    const folder = evaluate(
      "document.querySelector('file-tree-container').shadowRoot.querySelector('[aria-expanded=false]')?.getAttribute('aria-label')",
    );
    assert.ok(folder, "No accessible changed file or collapsed directory");
    const folderRow = snapshot.find((line) =>
      line.includes(`treeitem ${JSON.stringify(accessibleName(folder))} `),
    );
    const folderRef = folderRow?.match(/\bref=(\w+)/)?.[1];
    assert.ok(folderRef, `Missing accessible directory ${folder}`);
    browser("click", `@${folderRef}`);
  }
  assert.ok(fileRef, "Missing accessible changed file");
  browser("click", `@${fileRef}`);
  browser("wait", "diffs-container");
  browser("find", "role", "button", "click", "--name", "Unified", "--exact");
  browser(
    "wait",
    "--fn",
    "!!document.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]')",
  );
  const diff = evaluate(
    "(() => { const line = document.querySelector('diffs-container').shadowRoot.querySelector('[data-line]'); return {lineHeight:getComputedStyle(line).lineHeight,toolbar:document.querySelector('.file-diff-toolbar').getBoundingClientRect().toJSON()}; })()",
  );
  assert.equal(diff.lineHeight, "28px");
  assert.equal(diff.toolbar.height, 48);
  report.diff = diff;
  capture("unified-1920");
  browser("find", "role", "button", "click", "--name", "Split", "--exact");
  capture("split-1920");
  for (const [width, height] of contract.responsive) {
    browser("set", "viewport", String(width), String(height));
    if (width < 1100) {
      browser("click", '[aria-label="Toggle commit inspector"]');
      browser("wait", ".inspector");
    }
    capture(`split-${width}`);
    assert.equal(
      evaluate("document.documentElement.scrollWidth > innerWidth"),
      false,
    );
    if (width < 1100)
      browser("click", '[aria-label="Toggle commit inspector"]');
  }
  browser("press", "Escape");
  browser("wait", ".history:not([hidden])");
  capture("history-780");
  report.after = repositoryState();
  assert.deepEqual(
    report.after,
    before,
    "Reading the workspace changed Git state",
  );
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  assert.deepEqual(report.failures, [], "Active redesign contract mismatches");
  console.log(
    `Verified active workspace geometry, search, file filtering, Unified/Split, responsive inspector, and unchanged Git state. Evidence at ${directory}`,
  );
} finally {
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  browser("close");
}
