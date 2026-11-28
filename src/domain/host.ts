import { z } from "zod";
import type { Route } from "../transport";
import { pullDraftsSchema } from "./drafts";
import type { Anchor, DraftChange } from "./drafts";
import { pullRequestSchema, pullRequestsSchema } from "./pullRequest";
import type { PullRequestList } from "./pullRequest";
import {
  pullWriteSchema,
  seenSchema,
  writtenSchema,
} from "./pullRequestWrites";
import type { PullWrite } from "./pullRequestWrites";
import type { GitHubRepository, Oid } from "./repository";

const accessSchema = z.enum(["private", "publicOnly", "perRepository"]);

const hostStatusSchema = z.object({
  revision: z.number().int().nonnegative(),
  github: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("notConnected"),
      ended: z
        .object({
          login: z.string().nullable(),
          reason: z.enum(["revoked", "tokenMissing", "unreadable"]),
        })
        .nullable(),
    }),
    z.object({
      kind: z.literal("connected"),
      login: z.string(),
      api: z.string(),
      method: z.enum(["gh", "device"]),
      access: accessSchema,
      connectedAt: z.number().int().nonnegative(),
    }),
  ]),
  deviceSignIn: z.boolean(),
  deviceCode: z
    .object({
      session: z.string(),
      userCode: z.string(),
      verificationUri: z.string(),
      expiresInMs: z.number().int().nonnegative(),
      pollAfterMs: z.number().int().nonnegative(),
    })
    .nullable(),
});

const ghProbeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("outdated") }),
  z.object({ kind: z.literal("signedOut") }),
  z.object({ kind: z.literal("broken"), login: z.string() }),
  z.object({ kind: z.literal("failed"), detail: z.string() }),
  z.object({
    kind: z.literal("ready"),
    login: z.string(),
    access: accessSchema,
    path: z.string(),
  }),
]);

const failure = { message: z.string(), status: hostStatusSchema };
export const hostErrorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ghMissing"), ...failure }),
  z.object({ kind: z.literal("ghOutdated"), ...failure }),
  z.object({ kind: z.literal("ghSignedOut"), ...failure }),
  z.object({
    kind: z.literal("ghAccountChanged"),
    expected: z.string(),
    found: z.string(),
    ...failure,
  }),
  z.object({ kind: z.literal("ghFailed"), ...failure }),
  z.object({ kind: z.literal("rejected"), ...failure }),
  z.object({ kind: z.literal("signedOut"), ...failure }),
  z.object({ kind: z.literal("notConnected"), ...failure }),
  z.object({
    kind: z.literal("rateLimited"),
    resetAt: z.number().int().nullable(),
    ...failure,
  }),
  z.object({ kind: z.literal("unreachable"), ...failure }),
  z.object({ kind: z.literal("unanswered"), ...failure }),
  z.object({
    kind: z.literal("gitHubFailed"),
    httpStatus: z.number().int(),
    ...failure,
  }),
  z.object({
    kind: z.literal("keychain"),
    problem: z.enum(["locked", "unavailable"]),
    ...failure,
  }),
  z.object({ kind: z.literal("notFound"), ...failure }),
  z.object({ kind: z.literal("ssoRequired"), url: z.string(), ...failure }),
  z.object({ kind: z.literal("storage"), ...failure }),
  z.object({ kind: z.literal("interrupted"), ...failure }),
  z.object({ kind: z.literal("deviceUnavailable"), ...failure }),
  z.object({ kind: z.literal("deviceExpired"), ...failure }),
  z.object({ kind: z.literal("deviceDenied"), ...failure }),
]);

/** A write's answer, with what the pull request's drafts and writes hold
 * after it, when the host got as far as reading them. */
const wroteSchema = z.object({
  written: writtenSchema,
  drafts: pullDraftsSchema.nullable(),
});
export type Wrote = z.infer<typeof wroteSchema>;

/** What a read showed of the writes whose outcome was unknown. Those it
 * couldn't tell about are still in `drafts.sent`. */
const checkedSchema = z.object({
  settled: z.array(
    z.object({ attempt: z.string(), write: pullWriteSchema, seen: seenSchema }),
  ),
  drafts: pullDraftsSchema,
});

/** What opening a pull request from one head needs to know first. `open`
 * holds the pull requests open from that head in this repository, not a
 * fork's branch of the same name. */
const openPullContextSchema = z.object({
  repositoryId: z.string(),
  /** Null for a repository without commits. */
  defaultBranch: z.string().nullable(),
  open: z.array(z.object({ number: z.number().int(), base: z.string() })),
});

/** How opening a pull request ended. GitHub keeps one open pull request per
 * head and base, so a read of the context tells what an unknown one did. */
const openedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("done"), number: z.number().int() }),
  /** GitHub already has one from the head into the base, so none opened. */
  z.object({ kind: z.literal("alreadyOpen"), number: z.number().int() }),
  /** Nothing reached GitHub, so it is safe to open again. */
  z.object({ kind: z.literal("notSent"), message: z.string() }),
  /** GitHub answered and opened none. */
  z.object({ kind: z.literal("refused"), message: z.string() }),
  /** It left and no answer says whether GitHub opened it. */
  z.object({ kind: z.literal("unknown"), message: z.string() }),
]);
export type Opened = z.infer<typeof openedSchema>;

export const hostResponseSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status"), status: hostStatusSchema }),
  z.object({
    op: z.literal("probeGh"),
    data: ghProbeSchema,
    status: hostStatusSchema,
  }),
  z.object({ op: z.literal("connectGh"), status: hostStatusSchema }),
  z.object({ op: z.literal("disconnect"), status: hostStatusSchema }),
  z.object({ op: z.literal("verify"), status: hostStatusSchema }),
  z.object({ op: z.literal("deviceStart"), status: hostStatusSchema }),
  z.object({ op: z.literal("devicePoll"), status: hostStatusSchema }),
  z.object({ op: z.literal("deviceCancel"), status: hostStatusSchema }),
  z.object({
    op: z.literal("pullRequests"),
    data: pullRequestsSchema,
    status: hostStatusSchema,
  }),
  z.object({
    op: z.literal("pullRequest"),
    data: pullRequestSchema,
    status: hostStatusSchema,
  }),
  z.object({
    op: z.literal("drafts"),
    data: pullDraftsSchema,
    status: hostStatusSchema,
  }),
  z.object({
    op: z.literal("write"),
    data: wroteSchema,
    status: hostStatusSchema,
  }),
  z.object({
    op: z.literal("sendAgain"),
    data: wroteSchema,
    status: hostStatusSchema,
  }),
  z.object({
    op: z.literal("check"),
    data: checkedSchema,
    status: hostStatusSchema,
  }),
  z.object({
    op: z.literal("openPullContext"),
    data: openPullContextSchema,
    status: hostStatusSchema,
  }),
  z.object({
    op: z.literal("openPull"),
    data: openedSchema,
    status: hostStatusSchema,
  }),
]);

export type HostCommand =
  | { op: "status" | "probeGh" | "disconnect" | "verify" | "deviceStart" }
  | { op: "connectGh"; login: string }
  | { op: "devicePoll" | "deviceCancel"; session: string };

/** A question about GitHub's data, so any number can wait at once. */
export type HostRead =
  | { op: "pullRequests"; repository: GitHubRepository; list: PullRequestList }
  | { op: "pullRequest"; repository: GitHubRepository; number: number }
  | { op: "openPullContext"; repository: GitHubRepository; head: string };

/** Words on this computer, so it needs no sign-in and no network. */
export type HostDrafts = {
  op: "drafts";
  login: string;
  repository: GitHubRepository;
  number: number;
  change: DraftChange;
};

type PullAs = {
  asLogin: string;
  repository: GitHubRepository;
  number: number;
};

/** A draft a write carries, as saved at `at`. */
export type Carried = { anchor: Anchor; head: Oid; at: number };

/** A change on GitHub for `asLogin` only. Never merged, never sent twice.
 * The host keeps it as `attempt`, with the `drafts` it carries, from before
 * it leaves until its outcome is known. */
export type HostWrite = PullAs & {
  op: "write";
  attempt: string;
  write: PullWrite;
  drafts: readonly Carried[];
};

/** Send anyway: `attempt`'s write once more, unless a read first shows it
 * landed. */
export type HostSendAgain = PullAs & { op: "sendAgain"; attempt: string };

/** Reads what happened to the pull request's writes whose outcome is
 * unknown. It sends nothing. */
export type HostCheck = PullAs & { op: "check" };

/** Opens a pull request from `head` into `base` for `asLogin` only, at most
 * once. `repositoryId` is the one its context read. */
export type HostOpenPull = {
  op: "openPull";
  asLogin: string;
  repository: GitHubRepository;
  open: {
    repositoryId: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
  };
};

export type HostRequest =
  | HostCommand
  | HostRead
  | HostDrafts
  | HostWrite
  | HostSendAgain
  | HostCheck
  | HostOpenPull;

export const hostRequestOps = hostResponseSchema.options.map(
  (option) => option.shape.op.value,
);

export const hostRoute: Route = {
  command: "host_run",
  path: "/api/host",
  error: hostErrorSchema,
};

export type HostResponse = z.infer<typeof hostResponseSchema>;
/** `transport` is a failure to reach Rust at all, so it carries no status.
 * `unsent` says the request never got to Rust, so nothing it asks for ran. */
export type HostProblem =
  | z.infer<typeof hostErrorSchema>
  | { kind: "transport"; message: string; unsent?: true };
export type HostStatus = z.infer<typeof hostStatusSchema>;
export type GhProbe = z.infer<typeof ghProbeSchema>;
export type Access = z.infer<typeof accessSchema>;
