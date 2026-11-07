import { expect, it } from "vitest";
import { releaseNotes } from "./releaseNotes";

it("formats generated GitHub notes and numbered summaries", () => {
  expect(
    releaseNotes(
      "## What's Changed\n\n* Keep selection by @nallen in https://github.com/ImNallen/L1Git/pull/184\n* Flush frames (#181)",
    ),
  ).toEqual({
    kind: "changes",
    changes: [
      { title: "Keep selection", pullNumber: "184" },
      { title: "Flush frames", pullNumber: "181" },
    ],
  });
});

it("keeps plain multiline notes complete and ordered", () => {
  expect(releaseNotes("First fix\nSecond fix\nThird fix\nFourth fix")).toEqual({
    kind: "changes",
    changes: ["First fix", "Second fix", "Third fix", "Fourth fix"].map(
      (title) => ({ title, pullNumber: null }),
    ),
  });
});

it.each([
  "## Other heading\n* Keep this detail",
  "## What's Changed\n* A fix\n  <script>alert(1)</script>\n[link](javascript:alert(1))",
  "* Fix by @nallen in https://github.com.example/ImNallen/L1Git/pull/184",
  "* Fix by @nallen in https://github.com/another/repo/pull/184",
  "* Fix by @nallen in https://github.com/ImNallen/L1Git/pull/184?extra=true",
  "* Fix by @nallen in https://github.com/ImNallen/L1Git/pull/0",
  "```\ncode\n```",
  "A single plain release summary",
])("preserves unfamiliar notes literally: %s", (notes) => {
  expect(releaseNotes(notes)).toEqual({ kind: "text", text: notes });
});
