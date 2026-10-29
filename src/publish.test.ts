import { describe, expect, it } from "vitest";
import {
  publishDefaults,
  publishReview,
  initialPublishReview,
} from "./domain/publishReview";
import {
  publishOptionsSchema,
  pushIntentSchema,
  pushOutcomeSchema,
  pushOutcomeText,
} from "./domain/push";

const intent = pushIntentSchema.parse({
  purpose: "publish",
  branch: "refs/heads/topic",
  source: "a".repeat(40),
  remote: "origin",
  destination: "refs/heads/release",
  endpoint: "/private/remote.git",
  fingerprint: "b".repeat(40),
});

describe("publication review", () => {
  it("requires review and invalidates both valid and invalid edits before late responses arrive", () => {
    expect(initialPublishReview.step.kind).toBe("editing");
    const pending = publishReview(initialPublishReview, { kind: "prepare" });
    const edited = publishReview(pending, { kind: "edit" });
    expect(
      publishReview(edited, { kind: "prepared", generation: 0, intent }),
    ).toEqual(edited);
    expect(
      publishReview(edited, {
        kind: "failed",
        generation: 0,
        message: "old error",
      }),
    ).toEqual(edited);
    const next = publishReview(edited, { kind: "prepare" });
    const reviewed = publishReview(next, {
      kind: "prepared",
      generation: 1,
      intent,
    });
    expect(reviewed.step).toEqual({ kind: "review", intent });
    expect(publishReview(reviewed, { kind: "edit" }).step.kind).toBe("editing");
  });

  it("defaults to the local branch and selects only one eligible remote", () => {
    const options = publishOptionsSchema.parse({
      kind: "available",
      branch: intent.branch,
      source: intent.source,
      remotes: [],
    });
    if (options.kind !== "available") throw new Error("expected options");
    expect(publishDefaults(options)).toEqual({
      destination: "topic",
      remote: "",
    });
    const origin = {
      name: "origin",
      availability: { kind: "eligible", endpoint: "/remote.git" },
    } satisfies (typeof options.remotes)[number];
    const blocked = {
      name: "mirror",
      availability: { kind: "unavailable", reason: "mirror" },
    } satisfies (typeof options.remotes)[number];
    expect(
      publishDefaults({ ...options, remotes: [origin, blocked] }).remote,
    ).toBe("origin");
    expect(
      publishDefaults({
        ...options,
        remotes: [origin, { ...origin, name: "upstream" }],
      }).remote,
    ).toBe("");
    expect(publishDefaults({ ...options, remotes: [blocked] }).remote).toBe("");
  });

  it("makes tracking success impossible on uncertain, failed, or rejected publication", () => {
    for (const kind of ["uncertain", "failed", "rejected", "stale", "pushed"]) {
      expect(
        pushOutcomeSchema.safeParse({
          kind,
          message: "lost",
          tracking: { kind: "set" },
        }).success,
      ).toBe(false);
    }
    const outcome = pushOutcomeSchema.parse({
      kind: "published",
      tracking: { kind: "failed", message: "Upstream setup failed." },
    });
    expect(pushOutcomeText(outcome, intent)).toBe(
      "Published topic to origin/release. Upstream setup failed.",
    );
    expect(
      pushOutcomeText({ kind: "published", tracking: { kind: "set" } }, intent),
    ).toContain("Upstream set.");
    expect(
      pushIntentSchema.safeParse({ ...intent, purpose: undefined }).success,
    ).toBe(false);
  });
});
