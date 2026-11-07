import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [first, second, url = "http://127.0.0.1:1423"] = process.argv.slice(2);
if (!first || !second) {
  console.error(
    "Usage: node scripts/verify-graph-intro.mjs <repository> <sync repository> [url]",
  );
  process.exit(2);
}
const session = process.env.L1GIT_VISUAL_SESSION ?? "l1git-graph-intro";
const evidence =
  process.env.L1GIT_VISUAL_EVIDENCE ?? "/tmp/l1git-graph-intro/accepted";
const browser = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 120000,
  }).trim();
const a = basename(first);
const b = basename(second);
const page = (call) =>
  JSON.parse(
    browser(
      "eval",
      `(async () => (await import("/scripts/graph-intro.ts")).${call})()`,
    ),
  );
const save = (name, data) =>
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify(data, null, 2));
const pair = `${JSON.stringify(a)}, ${JSON.stringify(b)}`;
// The app shows canonical roots, and on macOS the fixture's temporary path is a symlink.
const saved = (root) =>
  `.repository-open[title$=${JSON.stringify(`/${basename(root)}`)}]`;

mkdirSync(evidence, { recursive: true });
browser("set", "viewport", "1440", "900");
browser("set", "media", "light");
browser("open", url);
browser("wait", ".repositories-heading button");
for (const root of [first, second]) {
  if (
    !JSON.parse(
      browser(
        "eval",
        `!!document.querySelector(${JSON.stringify(saved(root))})`,
      ),
    )
  ) {
    browser("click", ".repositories-heading button");
    browser("wait", "#repository-path");
    browser("fill", "#repository-path", root);
    browser("click", 'dialog button[type="submit"]');
    browser("wait", saved(root));
  }
}
for (const root of [second, first]) {
  browser("click", saved(root));
  browser("wait", ".history-table tbody tr[aria-rowindex]");
  browser("wait", "1500");
}

save("normal", page(`verifyGraphIntro(${pair})`));
console.log(
  "Timeline, fresh read, no-replay, resize, rapid, interruption and dissolve passed",
);

browser("reload");
browser("wait", ".history-table tbody tr[aria-rowindex]");
browser("wait", "1500");
save("mount", page(`verifyGraphIntroMount(${pair})`));
console.log("A repository with no cached snapshot plays when History mounts");
browser("wait", "1000");
save("first-load", page("verifyGraphIntroFirstLoad()"));
console.log("The app's first load plays once");

browser("set", "viewport", "1440", "280");
browser("wait", "400");
try {
  save("scroll", page(`verifyGraphIntroScroll(${pair})`));
} finally {
  browser("set", "viewport", "1440", "900");
}
console.log("Scrolling cancels and scroll restoration does not");

page(`startGraphIntro(${pair})`);
browser("set", "media", "light", "reduced-motion");
try {
  browser("wait", "100");
  const mid = page("runningGraphIntro()");
  if (mid.running !== 0)
    throw new Error(`Reduced motion left ${mid.running} tracks running`);
  browser("wait", "300");
  page("checkGraphIntroRest()");
  save("reduced", page(`verifyReducedGraphIntro(${pair})`));
} finally {
  browser("set", "media", "light");
}
console.log(`Graph intro checks passed. Evidence in ${evidence}`);
