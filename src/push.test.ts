import { describe, expect, it } from "vitest";
import { branchStatusSchema } from "./domain/overview";
import {
  nameRejection,
  pushAvailabilitySchema,
  pushControl,
  pushDisabledReason,
  pushIntentSchema,
  pushOutcomeText,
} from "./domain/push";

const intent = pushIntentSchema.parse({
  purpose: "upstream",
  branch: "refs/heads/local",
  source: "a".repeat(40),
  remote: "origin",
  destination: "refs/heads/published",
  endpoint: "Local or unrecognized remote",
  fingerprint: "b".repeat(40),
});

const local = (state: unknown, oid: string = intent.source) => [
  branchStatusSchema.parse({
    reference: "refs/heads/local",
    name: "local",
    oid,
    role: "default",
    checkedOutAt: "/fixture/pin",
    state,
  }),
];
const tracking = "refs/remotes/origin/published";
const behind = local({
  kind: "behind",
  upstream: tracking,
  target: "c".repeat(40),
  behind: 2,
  blocker: null,
});
const diverged = local({
  kind: "diverged",
  upstream: tracking,
  ahead: 1,
  behind: 2,
});
const rejected = {
  intent,
  outcome: { kind: "rejected", message: "The remote rejected this push." },
  refreshProblem: null,
} as const;

describe("push controls", () => {
  it("displays the full configured destination and source branch before click", () => {
    expect(pushControl({ kind: "ready", intent }, null, [])).toEqual({
      kind: "ready",
      intent,
      label: "Push to origin/published",
      title: "Push local to origin/published (Local or unrecognized remote).",
    });
  });
  it("explains every unsupported configuration and loading failure", () => {
    for (const reason of [
      "detached",
      "unborn",
      "noUpstream",
      "localUpstream",
      "unsupportedConfiguration",
      "mirror",
      "multipleEndpoints",
    ]) {
      const availability = pushAvailabilitySchema.parse({
        kind: "unavailable",
        reason,
      });
      expect(pushControl(availability, null, []).kind).toBe(
        reason === "noUpstream" ? "publish" : "disabled",
      );
      expect(pushDisabledReason(availability)?.length).toBeGreaterThan(20);
    }
    expect(pushDisabledReason(undefined)).toContain("Checking");
    expect(
      pushDisabledReason({ kind: "failed", message: "Refresh needed" }),
    ).toContain("Refresh needed");
  });
  it("distinguishes accepted publication from uncertain and stale outcomes", () => {
    expect(pushOutcomeText({ kind: "pushed" }, intent)).toBe(
      "Pushed local to origin/published.",
    );
    expect(pushOutcomeText({ kind: "upToDate" }, intent)).toContain(
      "already up to date",
    );
    expect(pushOutcomeText({ kind: "stale" }, intent)).toContain(
      "Review the current destination",
    );
    expect(
      pushOutcomeText(
        { kind: "uncertain", message: "Check the remote." },
        intent,
      ),
    ).toBe("Push result uncertain. Check the remote.");
  });
});

describe("push readiness", () => {
  const ready = { kind: "ready", intent } as const;
  it("disables Push with nothing to push and names a behind branch", () => {
    expect(pushControl(ready, null, behind)).toEqual({
      kind: "disabled",
      label: "Push to origin/published",
      title: "Nothing to push. local is 2 behind origin/published. Pull first.",
    });
    expect(
      pushControl(ready, null, local({ kind: "upToDate", upstream: tracking })),
    ).toEqual({
      kind: "disabled",
      label: "Push to origin/published",
      title: "Nothing to push. local is up to date with origin/published.",
    });
  });
  it("keeps Push enabled when there are commits to push", () => {
    expect(
      pushControl(
        ready,
        null,
        local({ kind: "ahead", upstream: tracking, ahead: 1 }),
      ).kind,
    ).toBe("ready");
    expect(pushControl(ready, null, diverged).kind).toBe("ready");
  });
  it("ignores counts that are not against the push destination", () => {
    const elsewhere = local({
      kind: "behind",
      upstream: "refs/remotes/fork/published",
      target: "c".repeat(40),
      behind: 2,
      blocker: null,
    });
    expect(pushControl(ready, null, elsewhere).kind).toBe("ready");
    const moved = local(
      { kind: "upToDate", upstream: tracking },
      "d".repeat(40),
    );
    expect(pushControl(ready, null, moved).kind).toBe("ready");
    expect(pushControl(ready, null, local({ kind: "untracked" })).kind).toBe(
      "ready",
    );
  });
  it("names a diverged or behind branch in the rejection", () => {
    const text = (branches: typeof behind) => {
      const result = nameRejection(rejected, branches);
      return pushOutcomeText(result.outcome, result.intent);
    };
    expect(text(diverged)).toBe(
      "Push rejected. local has diverged from origin/published (1 ahead, 2 behind). Pull, then push again.",
    );
    expect(text(behind)).toBe(
      "Push rejected. local is 2 behind origin/published. Pull first.",
    );
    expect(text(local({ kind: "ahead", upstream: tracking, ahead: 1 }))).toBe(
      "Push rejected. The remote rejected this push.",
    );
  });
});
