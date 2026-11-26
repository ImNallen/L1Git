import { z } from "zod";
import { operationNoun } from "./inProgress";
import { operationInProgressSchema } from "./merge";
import type { PullRequest } from "./pullRequest";
import { counted } from "./pullRequestDetail";
import { shortBranch } from "./refs";
import {
  githubRepositorySchema,
  localRefSchema,
  oidSchema,
  rootSchema,
} from "./repository";
import type { Oid } from "./repository";
import { shortOid } from "./shortOid";

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
    }),
  }),
]);

export type PullKey = z.infer<typeof pullKeySchema>;
export type PullHead = z.infer<typeof pullHeadSchema>;
export type PullCheckout = z.infer<typeof pullCheckoutSchema>;
export type HeldCheckout = Exclude<PullCheckout, { kind: "absent" }>;
export type Plan = z.infer<typeof planSchema>;
type Relation = HeldCheckout["relation"];
type Changes = Extract<PullCheckout, { kind: "ready" }>["worktree"]["changes"];

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
  // An author can lose write access to the base, so a role GitHub names
  // decides. Without one, the author once pushed the head branch there.
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

const commits = (count: number) => counted(count, "commit");

function relationWords(relation: Relation) {
  switch (relation.kind) {
    case "upToDate":
      return "up to date";
    case "behind":
      return `${commits(relation.commits)} behind the pull request`;
    case "ahead":
      return `${commits(relation.commits)} ahead of the pull request`;
    case "diverged":
      return `${commits(relation.ahead)} ahead of the pull request and ${relation.behind.toLocaleString()} behind it`;
    case "unfetched":
      return "the pull request has new commits on GitHub";
  }
}

function changesWords(changes: Changes) {
  switch (changes.kind) {
    case "clean":
      return [];
    case "uncommitted":
      return ["with uncommitted changes"];
    case "inProgress":
      return [`with ${operationNoun(changes.operation)} in progress`];
    case "missing":
      return ["but its folder is missing"];
  }
}

export function barWords(copy: HeldCheckout, home: string | null) {
  const at = [`at ${shortOid(copy.tip)}`, relationWords(copy.relation)];
  if (copy.kind === "parked")
    return {
      lead: "Kept locally as",
      place: shortBranch(copy.branch),
      state: [...at, "not checked out"].join(", "),
    };
  return {
    lead: "Checked out locally in",
    place: underHome(copy.worktree.root, home),
    state: [...at, ...changesWords(copy.worktree.changes)].join(", "),
  };
}

export type Move = { kind: "update" } | { kind: "replace"; leaving: number };

export function moveOf(copy: HeldCheckout): Move | null {
  if (copy.kind === "ready" && copy.worktree.changes.kind === "missing")
    return null;
  const { relation } = copy;
  switch (relation.kind) {
    case "upToDate":
      return null;
    case "behind":
    case "unfetched":
      return { kind: "update" };
    case "ahead":
      return { kind: "replace", leaving: relation.commits };
    case "diverged":
      return { kind: "replace", leaving: relation.ahead };
  }
}

export const removable = (copy: HeldCheckout) =>
  copy.kind === "ready" && !copy.worktree.main;

export function replaceWords(copy: HeldCheckout, leaving: number, head: Oid) {
  const branch = shortBranch(copy.branch);
  const left =
    leaving === 1
      ? `The commit on ${branch} that isn't in the pull request leaves the branch`
      : `The ${leaving.toLocaleString()} commits on ${branch} that aren't in the pull request leave the branch`;
  return {
    title: `Replace ${branch} with the pull request?`,
    body: [
      `${branch} moves to the pull request's head, ${shortOid(head)}.`,
      `${left}, and L1 Git can't undo that.`,
      ...(copy.kind === "ready"
        ? [
            "Uncommitted changes stay, and if the pull request changes the same files, nothing moves.",
          ]
        : []),
    ].join(" "),
  };
}

const stays = "so commits you make there stay local.";

function nowhere(
  why: Extract<Plan["pushes"], { kind: "nowhere" }>["why"],
  head: PullRequest["head"],
) {
  switch (why) {
    case "readOnly":
      return "Pulling from there brings the author's pushes. You can't push to this repository, so GitHub refuses a push from there.";
    case "noEdits":
      return head.maintainerCanModify
        ? `The author allows edits from maintainers, but you can't push to this repository, ${stays}`
        : `The author doesn't allow edits from maintainers, ${stays}`;
    case "forkGone":
      return `The fork this pull request came from is gone, ${stays}`;
    case "noRemote":
      return "No remote of this clone is the pull request's repository on GitHub, so L1 Git can't fetch the pull request.";
  }
}

export function pushesWords(pushes: Plan["pushes"], head: PullRequest["head"]) {
  if (pushes.kind === "nowhere") return nowhere(pushes.why, head);
  const tracks = `${pushes.remote}/${shortBranch(pushes.destination)}`;
  const owner =
    head.crossRepository && head.repository
      ? head.repository.owner
      : pushes.remote;
  const updates = "Pushing from there updates the pull request.";
  return pushes.addsRemote
    ? `Tracks ${tracks}, on a remote L1 Git adds for ${owner}'s fork. ${updates}`
    : `Tracks ${tracks}. ${updates}`;
}

/** `path` with `~` for `home` when it is under it, as a typed path takes it. */
export function underHome(path: string, home: string | null) {
  const base = home?.replace(/[/\\]+$/, "");
  if (!base || !path.startsWith(base)) return path;
  const rest = path.slice(base.length);
  return rest === "" || /^[/\\]/.test(rest) ? `~${rest}` : path;
}

/** What a note about the copy describes, so a read that finds it changed
 * can drop the note. */
export const standing = (checkout: PullCheckout) => JSON.stringify(checkout);
