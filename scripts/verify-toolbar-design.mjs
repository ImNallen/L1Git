import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [repositoryArgument, url = "http://localhost:1423"] =
  process.argv.slice(2);
if (!repositoryArgument)
  throw new Error(
    "Usage: node scripts/verify-toolbar-design.mjs <repository> [url]",
  );
const repository = realpathSync(repositoryArgument);
const directory = join(tmpdir(), `l1git-toolbar-${Date.now()}`);
const session = `l1git-toolbar-${process.pid}`;
mkdirSync(directory, { recursive: true });
const browser = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
const evaluate = (expression) => JSON.parse(browser("eval", expression));
const status = () =>
  execFileSync("git", ["-C", repository, "status", "--porcelain=v1"], {
    encoding: "utf8",
  });
const before = status();
const evidence = [];
try {
  browser("set", "viewport", "1920", "960");
  browser("open", url);
  browser("click", 'button[aria-label="Add repository"]');
  browser("click", '[role="option"]:first-child');
  browser("fill", 'input[aria-label="Path"]', repository);
  browser(
    "wait",
    "--fn",
    "!document.querySelector('dialog button[type=submit]').disabled",
  );
  browser("click", 'dialog button[type="submit"]');
  browser("wait", ".toolbar-action.fetch");
  browser("wait", "--fn", "document.fonts.status === 'loaded'");
  for (const [kind, width] of Object.entries({
    fetch: 94,
    pull: 84,
    push: 88,
    branch: 102,
    stash: 94,
    more: 82,
  })) {
    const selector = `.toolbar-action.${kind}`;
    browser("hover", 'input[aria-label="Search loaded history"]');
    browser(
      "wait",
      "--fn",
      `document.querySelector('${selector}').getAnimations().every(a => a.playState === 'finished')`,
    );
    browser("screenshot", join(directory, `${kind}-rest.png`));
    browser("hover", selector);
    browser(
      "wait",
      "--fn",
      `getComputedStyle(document.querySelector('${selector}')).backgroundColor === 'rgb(41, 41, 41)'`,
    );
    browser("screenshot", join(directory, `${kind}-hover.png`));
    browser("click", selector);
    browser(
      "wait",
      "--fn",
      "document.querySelector('.toolbar-menu')?.getAnimations({subtree:true}).every(a => a.playState === 'finished')",
    );
    const geometry = evaluate(`(() => {
      const button = document.querySelector('${selector}');
      const menu = document.querySelector('.toolbar-menu');
      const rect = menu.getBoundingClientRect();
      return {button:button.getBoundingClientRect().toJSON(),menu:rect.toJSON(),background:getComputedStyle(menu).backgroundColor,buttonBackground:getComputedStyle(button).backgroundColor,items:[...menu.querySelectorAll('[role=menuitem]')].map(e=>({height:e.getBoundingClientRect().height,text:e.textContent,disabled:e.getAttribute('aria-disabled')}))};
    })()`);
    assert.equal(geometry.button.width, width);
    assert.equal(geometry.button.height, 32);
    assert.equal(geometry.menu.width, 244);
    assert.equal(geometry.menu.x, geometry.button.x);
    assert.equal(geometry.menu.y - geometry.button.bottom, 6);
    assert.equal(geometry.background, "rgb(35, 35, 35)");
    assert.equal(geometry.buttonBackground, "rgb(52, 52, 52)");
    assert.ok(geometry.items.every((item) => item.height === 32));
    browser("press", "End");
    assert.ok(
      evaluate(
        "document.activeElement === [...document.querySelectorAll('.toolbar-menu [role=menuitem]')].at(-1)",
      ),
    );
    browser("press", "Home");
    assert.ok(
      evaluate(
        "document.activeElement === document.querySelector('.toolbar-menu [role=menuitem]')",
      ),
    );
    browser("screenshot", join(directory, `${kind}-open.png`));
    browser("press", "Escape");
    assert.ok(
      evaluate(
        `document.activeElement === document.querySelector('${selector}')`,
      ),
    );
    assert.equal(
      evaluate("document.querySelector('[role=menu]') !== null"),
      false,
    );
    evidence.push({ kind, geometry });
  }
  assert.equal(status(), before);
  writeFileSync(
    join(directory, "geometry.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    `Verified 18 toolbar states and keyboard navigation. Git status unchanged. Evidence at ${directory}`,
  );
} finally {
  browser("close");
}
