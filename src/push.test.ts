import { describe, expect, it } from "vitest";
import {
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

describe("push controls", () => {
  it("displays the full configured destination and source branch before click", () => {
    expect(pushControl({ kind: "ready", intent }, null)).toEqual({
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
      expect(pushControl(availability, null).kind).toBe(
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
