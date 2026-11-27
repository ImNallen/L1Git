import { describe, expect, it } from "vitest";
import { pull } from "../test/pullRequests";
import type { PullRequest, TimelineEvent } from "./pullRequest";
import { oidSchema } from "./repository";
import { reviewPointOf } from "./sinceReview";

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
