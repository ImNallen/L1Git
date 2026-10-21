import { describe, expect, it } from "vitest";
import { oidSchema } from "./repository";
import { matchCommits } from "./search";

const commits = [
  {
    oid: oidSchema.parse("3de65dea1c4b7e0f9a2d8c6b5e4f3a2b1c0d9e8f"),
    subject: "feat(app): add color themes",
    author: "Nora Allen",
    email: "nora@example.com",
  },
  {
    oid: oidSchema.parse("7729f2901ab3c4d5e6f708192a3b4c5d6e7f8091"),
    subject: "fix(history): keep the selection",
    author: "Sam Okafor",
    email: "sam.okafor@l1.dev",
  },
  {
    oid: oidSchema.parse("2c5082310fedcba98765432100112233445566ff"),
    subject: "docs: describe the Theme editor",
    author: "Nora Allen",
    email: "nora@example.com",
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

  it("matches nothing for an empty or blank query", () => {
    expect(match("")).toEqual([]);
    expect(match("   ")).toEqual([]);
  });
});
