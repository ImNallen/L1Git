import { expect, it } from "vitest";
import { changelog, countsPhrase } from "./changelog";

const fromChanges = (changes: string[]) =>
  changelog({ changes, notes: null }, "0.1.4");

it("lists features newest first and counts fixes, docs and everything else", () => {
  expect(
    fromChanges([
      "feat(pulls): move Refresh pull requests next to the search field (#198)",
      "fix(shell): keep focus after closing a notice (#197)",
      "feat: fold the files that didn't change since your review (#195)",
      "docs: explain nightly builds (#194)",
      "refactor(core)!: split the updater (#193)",
      "perf: cache tree rows",
      "test: cover rebases",
      "chore(deps): bump vite",
      "ci: pin node",
      "build: sign the app",
      "style: format",
      'revert: "feat: drop drafts"',
      "Polish the reset controls",
      "fix!: stop losing drafts",
    ]),
  ).toEqual({
    kind: "changes",
    since: "0.1.4",
    features: [
      {
        title: "Move Refresh pull requests next to the search field",
        pullNumber: "198",
      },
      {
        title: "Fold the files that didn't change since your review",
        pullNumber: "195",
      },
    ],
    fixes: 2,
    docs: 1,
    other: 9,
  });
});

it("strips the prefix and pull reference and keeps a feature's own capitals", () => {
  expect(
    fromChanges(["feat(ui)!: L1 opens faster", "feat: read a pull request"]),
  ).toMatchObject({
    features: [
      { title: "L1 opens faster", pullNumber: null },
      { title: "Read a pull request", pullNumber: null },
    ],
  });
});

it("counts each pull request once, keeping its newest subject", () => {
  expect(
    fromChanges([
      "feat: merge after one confirmation (#189)",
      "feat: merge after confirmation (#189)",
      "fix: guard merges (#189)",
      "fix: retry the merge",
      "fix: retry the merge",
    ]),
  ).toMatchObject({
    features: [{ title: "Merge after one confirmation", pullNumber: "189" }],
    fixes: 2,
    other: 0,
  });
});

it("reads the newest release's notes only when the history is unknown", () => {
  const notes =
    "## What's Changed\n\n* feat(pulls): keep selection by @nallen in https://github.com/ImNallen/L1Git/pull/184\n* fix: flush frames (#181)";
  const parsed = {
    kind: "changes",
    since: null,
    features: [{ title: "Keep selection", pullNumber: "184" }],
    fixes: 1,
    docs: 0,
    other: 0,
  };
  expect(changelog({ changes: null, notes }, "0.1.4")).toEqual(parsed);
  expect(changelog({ changes: [], notes }, "0.1.4")).toEqual(parsed);
  expect(
    changelog({ changes: ["docs: add a guide (#12)"], notes }, "0.1.4"),
  ).toEqual({
    kind: "changes",
    since: "0.1.4",
    features: [],
    fixes: 0,
    docs: 1,
    other: 0,
  });
});

it.each([null, "", " \n\t "])("has nothing to show for notes %j", (notes) => {
  expect(changelog({ changes: null, notes }, "0.1.4")).toBeNull();
});

it.each([
  "## Other heading\n* feat: keep this detail",
  "## What's Changed\n* feat: a fix\n  <script>alert(1)</script>\n[link](javascript:alert(1))",
  "* feat: fix by @nallen in https://github.com.example/ImNallen/L1Git/pull/184",
  "* feat: fix by @nallen in https://github.com/another/repo/pull/184",
  "* feat: fix by @nallen in https://github.com/ImNallen/L1Git/pull/184?extra=true",
  "* feat: fix by @nallen in https://github.com/ImNallen/L1Git/pull/0",
  "```\ncode\n```",
  "A single plain release summary",
  "First fix\nSecond fix\nThird fix",
])("preserves unfamiliar notes literally: %s", (notes) => {
  expect(changelog({ changes: null, notes }, "0.1.4")).toEqual({
    kind: "text",
    text: notes,
  });
});

it.each([
  [{ fixes: 1, docs: 0, other: 0 }, "1 fix"],
  [{ fixes: 2, docs: 1, other: 0 }, "2 fixes and 1 doc update"],
  [{ fixes: 0, docs: 2, other: 1 }, "2 doc updates and 1 other change"],
  [
    { fixes: 9, docs: 2, other: 4 },
    "9 fixes, 2 doc updates and 4 other changes",
  ],
  [{ fixes: 0, docs: 0, other: 3 }, "3 other changes"],
  [{ fixes: 0, docs: 0, other: 0 }, null],
])("sums %j as %j", (counts, phrase) => {
  expect(countsPhrase(counts)).toBe(phrase);
});
