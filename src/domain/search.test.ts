import { describe, expect, it } from "vitest";
import { oidSchema } from "./repository";
import type { Oid } from "./repository";
import {
  normalizeSearch,
  matchPositions,
  matchCommits,
  matchCount,
  stepMatch,
} from "./search";

const themes = oidSchema.parse("3de65dea1c4b7e0f9a2d8c6b5e4f3a2b1c0d9e8f");
const selection = oidSchema.parse("7729f2901ab3c4d5e6f708192a3b4c5d6e7f8091");
const editor = oidSchema.parse("2c5082310fedcba98765432100112233445566ff");
const cafe = oidSchema.parse("9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b");

const commits = [
  {
    oid: themes,
    subject: "feat(app): add color themes",
    author: "Nora Allen",
    email: "nora@example.com",
  },
  {
    oid: selection,
    subject: "fix(history): keep the selection",
    author: "Sam Okafor",
    email: "sam.okafor@l1.dev",
  },
  {
    oid: editor,
    subject: "docs: describe the Theme editor",
    author: "Nora Allen",
    email: "nora@example.com",
  },
  {
    oid: cafe,
    subject: "chore: rename the Café fixture",
    author: "Renée Dubois",
    email: "renee@example.com",
  },
];

const match = (query: string) => matchCommits(commits, query);

describe("history search", () => {
  it("matches a word in the subject, in history order", () => {
    expect(match("theme")).toEqual([
      "3de65dea1c4b7e0f9a2d8c6b5e4f3a2b1c0d9e8f",
      "2c5082310fedcba98765432100112233445566ff",
    ]);
  });

  it("matches part of an author name", () => {
    expect(match("okaf")).toEqual(["7729f2901ab3c4d5e6f708192a3b4c5d6e7f8091"]);
  });

  it("matches part of an email", () => {
    expect(match("@l1.dev")).toEqual([
      "7729f2901ab3c4d5e6f708192a3b4c5d6e7f8091",
    ]);
  });

  it("matches a SHA only at its start", () => {
    expect(match("2c50823")).toEqual([
      "2c5082310fedcba98765432100112233445566ff",
    ]);
    expect(match("5082310")).toEqual([]);
  });

  it("ignores case in the query and the commit", () => {
    expect(match("NORA ALLEN")).toEqual([
      "3de65dea1c4b7e0f9a2d8c6b5e4f3a2b1c0d9e8f",
      "2c5082310fedcba98765432100112233445566ff",
    ]);
    expect(match("7729F29")).toEqual([
      "7729f2901ab3c4d5e6f708192a3b4c5d6e7f8091",
    ]);
  });

  it("matches composed and decomposed accents either way", () => {
    expect(match("café")).toEqual(["9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b"]);
    expect(match("RENÉE")).toEqual([
      "9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b",
    ]);
    expect(normalizeSearch("Café")).toBe("café");
  });

  it("never matches across the subject, author, and email", () => {
    expect(match("themesnora")).toEqual([]);
    expect(match("themes nora")).toEqual([]);
  });

  it("matches nothing for an empty or blank query", () => {
    expect(match("")).toEqual([]);
    expect(match("   ")).toEqual([]);
  });
});

describe("history search count", () => {
  const matches = matchPositions([themes, editor]);
  const count = (selected: Oid | null) =>
    matchCount("theme", matches, selected);

  it("reads n of m when the selected commit is a match", () => {
    expect(count(themes)).toBe("1 of 2");
    expect(count(editor)).toBe("2 of 2");
  });

  it("reads the total when the selected commit is not a match", () => {
    expect(count(selection)).toBe("2 matches");
    expect(count(null)).toBe("2 matches");
    expect(matchCount("okaf", matchPositions([selection]), cafe)).toBe(
      "1 match",
    );
  });

  it("says no matches, and nothing for an empty query", () => {
    expect(matchCount("zzzz", matchPositions([]), themes)).toBe("No matches");
    expect(matchCount("  ", matchPositions([]), themes)).toBe("");
  });

  it("formats large counts", () => {
    const many = Array.from({ length: 1234 }, (_, index) =>
      oidSchema.parse(index.toString(16).padStart(40, "0")),
    );
    expect(matchCount("a", matchPositions(many), many[999] ?? null)).toBe(
      "1,000 of 1,234",
    );
  });
});

describe("history search steps", () => {
  const matches = matchPositions([themes, editor]);
  const step = (selected: Oid | null, by: 1 | -1) =>
    stepMatch(commits, matches, selected, by);

  it("starts from the top with no selection", () => {
    expect(step(null, 1)).toBe(themes);
    expect(step(null, -1)).toBe(editor);
  });

  it("steps from a selected match to the next and previous, wrapping", () => {
    expect(step(themes, 1)).toBe(editor);
    expect(step(editor, 1)).toBe(themes);
    expect(step(themes, -1)).toBe(editor);
  });

  it("steps from a selected commit that is not a match", () => {
    expect(step(selection, 1)).toBe(editor);
    expect(step(selection, -1)).toBe(themes);
    expect(step(cafe, 1)).toBe(themes);
    expect(step(cafe, -1)).toBe(editor);
  });

  it("returns the only match again, and nothing without matches", () => {
    expect(stepMatch(commits, matchPositions([editor]), editor, 1)).toBe(
      editor,
    );
    expect(stepMatch(commits, matchPositions([]), editor, 1)).toBeNull();
  });
});
