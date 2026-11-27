import { describe, expect, it } from "vitest";
import { pull } from "../test/pullRequests";
import { pullRequestSchema } from "./pullRequest";

const answer = (fields: Record<string, unknown>) =>
  pullRequestSchema.safeParse({ ...pull(1), ...fields });

describe("pullRequestSchema", () => {
  it.each([
    { kind: "none" },
    { kind: "unknown" },
    { kind: "review", id: "PRR_1", comments: { items: [], total: 0 } },
  ])("reads a pending review that is $kind", (pending) => {
    expect(answer({ pending }).data?.pending).toEqual(pending);
  });

  it.each([
    ["an id GitHub would never send", { id: "" }],
    [
      "a pending review with no id",
      {
        pending: { kind: "review", id: "", comments: { items: [], total: 0 } },
      },
    ],
    [
      "a merge method L1 Git can't name",
      { merge: { ...pull(1).merge, preferred: "octopus" } },
    ],
    [
      "a thread without what the viewer may do",
      { threads: { items: [{ ...thread(), can: undefined }], total: 1 } },
    ],
  ])("refuses %s", (_, fields) => {
    expect(answer(fields).success).toBe(false);
  });
});

function thread() {
  return {
    id: "T1",
    review: null,
    path: "a.ts",
    line: 1,
    startLine: null,
    originalLine: 1,
    originalStartLine: null,
    side: "right",
    outdated: false,
    resolved: false,
    hunk: "",
    comments: { items: [], total: 0 },
    can: { reply: true, resolve: true, unresolve: false },
  };
}
