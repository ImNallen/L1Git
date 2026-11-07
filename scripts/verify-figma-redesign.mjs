import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [
  url = "http://localhost:1423",
  directory = join(tmpdir(), `l1git-figma-${Date.now()}`),
] = process.argv.slice(2);
const session = `l1git-figma-${process.pid}`;
mkdirSync(directory, { recursive: true });
const browser = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
const evaluate = (expression) => JSON.parse(browser("eval", expression));
const verifyIcons = () => {
  const failures = evaluate(`(async () => {
    const failures = [];
    for (const icon of document.querySelectorAll('.workspace-icon')) {
      const source = getComputedStyle(icon).getPropertyValue('--icon').match(/url\\(["']?([^"')]+)/)?.[1];
      if (!source) { failures.push('Missing icon source'); continue; }
      const image = new Image(); image.src = source;
      try { await image.decode(); } catch { failures.push('Failed to load ' + source); continue; }
      if (!source.includes('/workspace/')) {
        const style = getComputedStyle(icon);
        if (parseFloat(style.width) !== image.naturalWidth || parseFloat(style.height) !== image.naturalHeight) failures.push('Incorrect dimensions for ' + source);
      }
    }
    return failures;
  })()`);
  assert.deepEqual(failures, []);
};
const evidence = [];
try {
  browser("set", "viewport", "1920", "960");
  for (const track of ["stable", "nightly"]) {
    for (const interval of [0, 5, 15, 30, 60]) {
      browser(
        "open",
        `${url}/scripts/figma-redesign.html?track=${track}&interval=${interval}`,
      );
      browser("wait", ".settings-installed");
      browser(
        "wait",
        "--fn",
        "document.fonts.status === 'loaded' && document.querySelector('.settings-installed').textContent.includes('20261106')",
      );
      const layout = evaluate(`(() => {
        const selectors = ['.settings-dialog', '.settings-page-heading', '.settings-fetch-row', '.settings-row-group'];
        return Object.fromEntries(selectors.map(selector => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return [selector, {x: rect.x, y: rect.y, width: rect.width, height: rect.height}];
        }));
      })()`);
      assert.equal(layout[".settings-dialog"].width, 1004);
      assert.equal(layout[".settings-dialog"].height, 752);
      assert.equal(layout[".settings-fetch-row"].width, 664);
      assert.equal(layout[".settings-fetch-row"].height, 87);
      assert.equal(layout[".settings-row-group"].height, 145);
      assert.equal(
        evaluate(
          "document.querySelector('input[name=fetch-interval]:checked').value",
        ),
        String(interval),
      );
      browser(
        "wait",
        "--fn",
        "[...document.querySelectorAll('.settings-dialog img')].every(img => img.complete && img.naturalWidth > 0)",
      );
      verifyIcons();
      browser(
        "screenshot",
        join(directory, `general-${track}-${interval}.png`),
      );
      evidence.push({ track, interval, layout });
    }
  }
  for (const state of [
    "current",
    "checking",
    "available",
    "downloading",
    "downloaded",
    "installing",
  ]) {
    for (const width of [280, 210]) {
      browser(
        "open",
        `${url}/scripts/figma-redesign.html?screen=update&state=${state}&width=${width}`,
      );
      browser("wait", ".sidebar-updater");
      browser("wait", "--fn", "document.fonts.status === 'loaded'");
      browser("hover", ".sidebar-updater");
      browser(
        "wait",
        "--fn",
        "document.fonts.status === 'loaded' && [...document.querySelectorAll('.sidebar-updater img')].every(img => img.complete && img.naturalWidth > 0)",
      );
      verifyIcons();
      const rect = evaluate(
        "document.querySelector('.update-tooltip').getBoundingClientRect().toJSON()",
      );
      assert.ok(
        rect.x >= 0 && rect.right <= 1920,
        `Update card escaped viewport at ${width}px`,
      );
      if (
        ["available", "downloading", "downloaded", "installing"].includes(state)
      ) {
        assert.equal(rect.width, 356);
        assert.ok(
          evaluate(
            "document.querySelector('.update-tooltip-notes').textContent.includes('queued frames')",
          ),
        );
      }
      browser("screenshot", join(directory, `update-${state}-${width}.png`));
      evidence.push({ state, width, rect });
    }
  }
  writeFileSync(
    join(directory, "geometry.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    `Verified ${evidence.length} design states. Evidence at ${directory}`,
  );
} finally {
  browser("close");
}
