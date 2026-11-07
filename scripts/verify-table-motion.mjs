import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const session = process.env.L1GIT_VISUAL_SESSION ?? "l1git-table-motion";
const evidence =
  process.env.L1GIT_VISUAL_EVIDENCE ?? "/tmp/l1git-table-motion/accepted";
const browser = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
mkdirSync(evidence, { recursive: true });
browser("set", "media", "light");
const normal = JSON.parse(
  browser(
    "eval",
    '(async () => (await import("/scripts/table-motion.ts")).verifyTableMotion())()',
  ),
);
writeFileSync(`${evidence}/normal.json`, JSON.stringify(normal, null, 2));
browser("set", "media", "light", "reduced-motion");
try {
  const reduced = JSON.parse(
    browser(
      "eval",
      '(async () => (await import("/scripts/table-motion.ts")).verifyReducedTableMotion())()',
    ),
  );
  writeFileSync(`${evidence}/reduced.json`, JSON.stringify(reduced, null, 2));
} finally {
  browser("set", "media", "light");
}
console.log(`Table and pane motion checks passed. Evidence in ${evidence}`);
