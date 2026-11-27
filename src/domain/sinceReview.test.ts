import { describe, expect, it } from "vitest";
import { pull } from "../test/pullRequests";
import type { PullRequest, TimelineEvent } from "./pullRequest";
import { oidSchema } from "./repository";
import type { RangeFile } from "./range";
import { baseWords, reviewPointOf, sinceGroups } from "./sinceReview";

const at = "2026-11-24T18:00:00Z";
const head = oidSchema.parse("1".repeat(40));
const reviewed = oidSchema.parse("e".repeat(40));
const reviewedAt = (
  oid: PullRequest["head"]["oid"] | null,
  fields: Partial<PullRequest> = {},
) => pull(1, { reviewed: { oid, at }, ...fields });

describe("reviewPointOf", () => {
  it("is the commit and time of your review once the head has moved", () => {
    expect(reviewPointOf(reviewedAt(reviewed))).toEqual({ oid: reviewed, at });
  });

  it("is nothing before you review", () => {
    expect(reviewPointOf(pull(1, { reviewed: null }))).toBeNull();
  });

  it("is nothing on your own pull request", () => {
    expect(
      reviewPointOf(reviewedAt(reviewed, { viewerIsAuthor: true })),
    ).toBeNull();
  });

  it("is nothing while the head is the commit you reviewed", () => {
    expect(reviewPointOf(reviewedAt(head))).toBeNull();
  });

  it("keeps a review of a commit GitHub no longer has, without its commit", () => {
    expect(reviewPointOf(reviewedAt(null))).toEqual({ oid: null, at });
  });

  it("is nothing once the base changed after your review, and stays when it changed before", () => {
    const retarget = (when: string): TimelineEvent => ({
      id: "B1",
      kind: "baseChanged",
      from: "main",
      to: "release",
      by: "maja",
      at: when,
    });
    const timeline = (when: string) => ({
      timeline: { items: [retarget(when)], total: 1 },
    });
    expect(
      reviewPointOf(reviewedAt(reviewed, timeline("2026-11-24T19:00:00Z"))),
    ).toBeNull();
    expect(
      reviewPointOf(reviewedAt(reviewed, timeline("2026-11-24T17:00:00Z"))),
    ).toEqual({ oid: reviewed, at });
  });
});

const blob = (digit: string) => oidSchema.parse(digit.repeat(40));
const file = (
  path: string,
  newBlob: string,
  fields: Partial<RangeFile> = {},
): RangeFile => ({
  path,
  status: "M",
  from: null,
  similarity: null,
  added: 1,
  deleted: 1,
  oldBlob: blob("0"),
  newBlob: blob(newBlob),
  oldMode: "100644",
  newMode: "100644",
  submodule: false,
  ...fields,
});

describe("sinceGroups", () => {
  it("splits the pull request's files into changed again, rebased and unchanged, which add up to them", () => {
    const now = [file("a.ts", "2"), file("b.ts", "3"), file("c.ts", "4")];
    const reviewed = [file("a.ts", "1"), file("b.ts", "1"), file("c.ts", "4")];
    const since = [file("a.ts", "2", { oldBlob: blob("9") })];
    const { again, rebased, unchanged } = sinceGroups(now, {
      files: since,
      reviewed,
    });
    expect(again).toEqual([{ since: since[0], now: now[0] }]);
    expect(rebased).toEqual([{ now: now[1], reviewed: reviewed[1] }]);
    expect(unchanged).toEqual([now[2]]);
    expect(again.length + rebased.length + unchanged.length).toBe(now.length);
  });

  it("matches a file renamed since the review by its new path", () => {
    const now = [file("a2.ts", "2", { status: "R", from: "a.ts" })];
    const since = [file("a2.ts", "2", { status: "R", from: "a.ts" })];
    const { again } = sinceGroups(now, {
      files: since,
      reviewed: [file("a.ts", "1")],
    });
    expect(again).toEqual([{ since: since[0], now: now[0] }]);
  });

  it("keeps a file the pull request no longer changes, without a file of its own", () => {
    const since = [file("b.ts", "0")];
    const { again, rebased } = sinceGroups([file("a.ts", "1")], {
      files: since,
      reviewed: [file("a.ts", "1"), file("b.ts", "1")],
    });
    expect(again).toEqual([{ since: since[0], now: null }]);
    expect(rebased).toEqual([]);
  });

  it("leaves out the base's own files, which an untold read lists", () => {
    const now = [file("a.ts", "2")];
    const { again } = sinceGroups(now, {
      files: [file("a.ts", "2"), file("main-only.ts", "5")],
      reviewed: [file("a.ts", "1")],
    });
    expect(again.map(({ since }) => since.path)).toEqual(["a.ts"]);
  });

  it("counts a file without a reviewed file as rebased", () => {
    const now = [file("new.ts", "2", { status: "A", oldBlob: null })];
    const { rebased } = sinceGroups(now, { files: [], reviewed: [] });
    expect(rebased).toEqual([{ now: now[0], reviewed: null }]);
  });
});

describe("baseWords", () => {
  const point = { oid: reviewed, at };
  const pushed = (when: string): TimelineEvent => ({
    id: "F1",
    kind: "forcePushed",
    from: null,
    to: null,
    by: "maja",
    at: when,
  });
  const after = pull(1, {
    timeline: { items: [pushed("2026-11-24T19:00:00Z")], total: 1 },
  });

  it("names who rebased after your review, or says the base was merged in", () => {
    expect(baseWords({ kind: "leftOut" }, after, point, "me")).toBe(
      "maja rebased onto main after your review.",
    );
    const before = pull(1, {
      timeline: { items: [pushed("2026-11-24T17:00:00Z")], total: 1 },
    });
    expect(baseWords({ kind: "leftOut" }, before, point, "me")).toBe(
      "main was merged in after your review.",
    );
  });

  it("says the base's changes show when Git couldn't tell them apart, and why", () => {
    expect(
      baseWords({ kind: "untold", why: "shallow" }, after, point, "me"),
    ).toBe(
      "main also changed since your review, and its changes show here too. This clone is shallow.",
    );
    expect(baseWords({ kind: "none" }, after, point, "me")).toBeNull();
  });
});
