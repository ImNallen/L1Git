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
  number: z.number().int().positive(),
});
export const pullHeadSchema = z.strictObject({
  reference: localRefSchema,
  oid: oidSchema,
  from: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("same") }),
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
      why: z.enum(["noEdits", "forkGone"]),
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

export function pullHead(pull: PullRequest): PullHead {
  const { branch, oid, repository, crossRepository, maintainerCanModify } =
    pull.head;
  const forkIsYours = pull.viewerIsAuthor;
  return pullHeadSchema.parse({
    reference: `refs/heads/${branch}`,
    oid,
    from: !crossRepository
      ? { kind: "same" }
      : repository === null
        ? { kind: "gone" }
        : {
            kind: "fork",
            repository,
            edits: maintainerCanModify || forkIsYours,
          },
  });
}
