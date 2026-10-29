import { z } from "zod";
import { branchRefSchema, overviewSchema } from "./overview";
import { oidSchema } from "./repository";

export const pushIntentSchema = z.strictObject({
  branch: branchRefSchema,
  source: oidSchema,
  remote: z.string().min(1),
  destination: branchRefSchema,
  endpoint: z.string(),
  fingerprint: z.string().regex(/^[0-9a-f]{40}$/),
});
export const pushUnavailableSchema = z.enum([
  "detached",
  "unborn",
  "noUpstream",
  "localUpstream",
  "unsupportedConfiguration",
  "mirror",
  "multipleEndpoints",
]);
export const pushAvailabilitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready"), intent: pushIntentSchema }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: pushUnavailableSchema,
  }),
]);
export const pushOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pushed") }),
  z.strictObject({ kind: z.literal("upToDate") }),
  z.strictObject({ kind: z.literal("stale") }),
  z.strictObject({ kind: z.literal("rejected"), message: z.string() }),
  z.strictObject({ kind: z.literal("failed"), message: z.string() }),
  z.strictObject({ kind: z.literal("uncertain"), message: z.string() }),
]);
export const pushReportSchema = z.strictObject({
  outcome: pushOutcomeSchema,
  refresh: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("refreshed"),
      overview: overviewSchema,
      availability: pushAvailabilitySchema,
    }),
    z.strictObject({ kind: z.literal("failed"), message: z.string() }),
  ]),
});
export type PushIntent = z.infer<typeof pushIntentSchema>;
export type PushAvailability = z.infer<typeof pushAvailabilitySchema>;
export type PushOutcome = z.infer<typeof pushOutcomeSchema>;
export type PushReport = z.infer<typeof pushReportSchema>;
export type PushPreparation =
  | PushAvailability
  | { kind: "loading" }
  | { kind: "failed"; message: string };

const unavailableText: Record<z.infer<typeof pushUnavailableSchema>, string> = {
  detached: "Check out a branch to push.",
  unborn: "Create a commit before pushing.",
  noUpstream: "This branch has no configured upstream. Set one with Git first.",
  localUpstream:
    "This branch tracks a local branch. Choose a remote upstream with Git first.",
  unsupportedConfiguration:
    "This branch's upstream configuration is unsupported. Check its remote and merge branch in Git.",
  mirror: "Push is unavailable for a mirror remote.",
  multipleEndpoints: "Push requires exactly one effective push URL.",
};

export function pushDestination(intent: PushIntent): string {
  return `${intent.remote}/${intent.destination.replace(/^refs\/heads\//, "")}`;
}

export function pushDisabledReason(
  preparation: PushPreparation | undefined,
): string | null {
  if (!preparation || preparation.kind === "loading")
    return "Checking the current branch's upstream…";
  switch (preparation.kind) {
    case "ready":
      return null;
    case "failed":
      return `Could not check the push destination. ${preparation.message}`;
    case "unavailable":
      return unavailableText[preparation.reason];
    default: {
      const exhaustive: never = preparation;
      return exhaustive;
    }
  }
}

export function pushOutcomeText(
  outcome: PushOutcome,
  intent: PushIntent,
): string {
  const target = pushDestination(intent);
  switch (outcome.kind) {
    case "pushed":
      return `Pushed ${intent.branch.replace(/^refs\/heads\//, "")} to ${target}.`;
    case "upToDate":
      return `${target} is already up to date.`;
    case "stale":
      return "The branch or push destination changed. Review the current destination before pushing again.";
    case "rejected":
      return `Push rejected. ${outcome.message}`;
    case "failed":
      return `Push failed. ${outcome.message}`;
    case "uncertain":
      return `Push result uncertain. ${outcome.message}`;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export type PushControl =
  | { kind: "ready"; intent: PushIntent; label: string; title: string }
  | { kind: "disabled"; label: string; title: string };

export function pushControl(
  preparation: PushPreparation | undefined,
  busy: string | null,
): PushControl {
  const label =
    preparation?.kind === "ready"
      ? `Push to ${pushDestination(preparation.intent)}`
      : "Push";
  const reason = busy ?? pushDisabledReason(preparation);
  if (reason || preparation?.kind !== "ready")
    return {
      kind: "disabled",
      label,
      title: reason ?? "Check the current push destination.",
    };
  return {
    kind: "ready",
    intent: preparation.intent,
    label,
    title: `Push ${preparation.intent.branch.replace(/^refs\/heads\//, "")} to ${pushDestination(preparation.intent)} (${preparation.intent.endpoint}).`,
  };
}
