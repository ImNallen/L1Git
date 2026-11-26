import { z } from "zod";
import { operationInProgressSchema } from "./merge";
import type { PullRequest } from "./pullRequest";
import {
  githubRepositorySchema,
  localRefSchema,
  oidSchema,
  repositoryErrorSchema,
  rootSchema,
} from "./repository";

export const pullKeySchema = z.strictObject({
  github: githubRepositorySchema,
  number: z
    .number()
    .int()
    .positive()
    .max(2 ** 32 - 1),
});
export const pullHeadSchema = z.strictObject({
  reference: localRefSchema,
  oid: oidSchema,
  from: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("same"),
      /** The repository takes your pushes. */
      edits: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal("fork"),
      repository: githubRepositorySchema,
      /** The fork takes your pushes. */
      edits: z.boolean(),
    }),
    z.strictObject({ kind: z.literal("gone") }),
  ]),
});

const count = z.number().int().nonnegative();
const relationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upToDate") }),
  z.strictObject({ kind: z.literal("behind"), commits: count }),
  z.strictObject({ kind: z.literal("ahead"), commits: count }),
  z.strictObject({ kind: z.literal("diverged"), ahead: count, behind: count }),
  z.strictObject({ kind: z.literal("unfetched") }),
]);
const planSchema = z.strictObject({
  folder: z.string().min(1),
  pushes: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("toPullRequest"),
      remote: z.string().min(1),
      destination: localRefSchema,
      addsRemote: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal("nowhere"),
      /** `noRemote`: no remote of the repository is the pull request's, so Try cannot fetch it. */
      why: z.enum(["noEdits", "forkGone", "noRemote", "readOnly"]),
    }),
  ]),
});
const copy = {
  branch: localRefSchema,
  tip: oidSchema,
  relation: relationSchema,
};
export const pullCheckoutSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("absent"),
    branch: localRefSchema,
    plan: planSchema,
  }),
  z.strictObject({ kind: z.literal("parked"), ...copy, plan: planSchema }),
  z.strictObject({
    kind: z.literal("ready"),
    ...copy,
    worktree: z.strictObject({
      root: rootSchema,
      name: z.string().min(1),
      main: z.boolean(),
      changes: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("clean") }),
        z.strictObject({ kind: z.literal("uncommitted") }),
        z.strictObject({
          kind: z.literal("inProgress"),
          operation: operationInProgressSchema,
        }),
        z.strictObject({ kind: z.literal("missing") }),
      ]),
      /** Git made the worktree, but its post-checkout hook failed or was stopped. */
      trouble: repositoryErrorSchema.nullable(),
    }),
  }),
]);

export type PullKey = z.infer<typeof pullKeySchema>;
export type PullHead = z.infer<typeof pullHeadSchema>;
export type PullCheckout = z.infer<typeof pullCheckoutSchema>;

/** The roles that can push to the base repository. GitHub lets them push to
 * a fork that allows edits too, as maintainers. */
const writers = new Set<PullRequest["viewerPermission"]>([
  "admin",
  "maintain",
  "write",
]);

export function pullHead(pull: PullRequest): PullHead {
  const { branch, oid, repository, crossRepository, maintainerCanModify } =
    pull.head;
  const { viewerIsAuthor, viewerPermission } = pull;
  const writes = writers.has(viewerPermission);
  /** An author can lose write access to the base, so a role GitHub names
   * decides. Without one, the author once pushed the head branch there. */
  const writesBase = viewerPermission === "unknown" ? viewerIsAuthor : writes;
  const edits = viewerIsAuthor || (maintainerCanModify && writes);
  return pullHeadSchema.parse({
    reference: `refs/heads/${branch}`,
    oid,
    from: !crossRepository
      ? { kind: "same", edits: writesBase }
      : repository === null
        ? { kind: "gone" }
        : {
            kind: "fork",
            repository,
            edits,
          },
  });
}
