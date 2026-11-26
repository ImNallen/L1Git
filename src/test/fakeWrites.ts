import type { HostStatus } from "../domain/host";
import type {
  PullRequest,
  ReviewThread,
  TimelineEvent,
} from "../domain/pullRequest";
import type { PullWrite, Written } from "../domain/pullRequestWrites";

/** What the next write answers. A write with none left is done. */
export type WriteScript =
  | { kind: "done" }
  | { kind: "refused"; message?: string }
  | { kind: "notSent"; message?: string }
  /** Sent with no answer; `applied` says whether GitHub did it anyway. */
  | { kind: "unknown"; applied: boolean };

type Host = {
  status: HostStatus;
  details: Map<string, PullRequest>;
  writes: WriteScript[];
};

type Commented = Pick<
  Extract<PullWrite, { kind: "singleComment" }>,
  "lines" | "body"
>;

type Change =
  | { next: PullRequest; echo: Extract<Written, { kind: "done" }>["echo"] }
  | { refused: string };

let made = 0;
const fresh = (prefix: string) => `${prefix}_fake${(made += 1)}`;
const added = <T>(page: { items: readonly T[]; total: number }, item: T) => ({
  items: [...page.items, item],
  total: page.total + 1,
});

function find(details: Map<string, PullRequest>, write: PullWrite) {
  const named = (pull: PullRequest) => {
    if ("pull" in write) return pull.id === write.pull;
    if ("thread" in write)
      return pull.threads?.items.some(({ id }) => id === write.thread);
    return pull.pending.kind === "review" && pull.pending.id === write.review;
  };
  return [...details].find(([, pull]) => named(pull));
}

function threadsOf(
  pull: PullRequest,
  thread: string,
  change: (thread: ReviewThread) => ReviewThread,
): PullRequest {
  const threads = pull.threads ?? { items: [], total: 0 };
  return {
    ...pull,
    threads: {
      ...threads,
      items: threads.items.map((each) =>
        each.id === thread ? change(each) : each,
      ),
    },
  };
}

/** What GitHub would make of `write`, as the next read shows it. */
function change(write: PullWrite, pull: PullRequest, by: string): Change {
  const at = new Date().toISOString();
  const said = (body: string) => ({ id: fresh("C"), body, by, at });
  const event = (item: TimelineEvent): PullRequest["timeline"] =>
    added(pull.timeline, item);
  const thread = (
    review: string,
    { lines, body }: Commented,
  ): ReviewThread => ({
    id: fresh("T"),
    review,
    path: lines.path,
    line: lines.line,
    startLine: lines.start?.line ?? null,
    originalLine: lines.line,
    originalStartLine: lines.start?.line ?? null,
    side: lines.side,
    outdated: false,
    resolved: false,
    hunk: "",
    comments: { items: [said(body)], total: 1 },
    can: { reply: true, resolve: true, unresolve: false },
  });
  const reviewed = (
    state: "commented" | "approved" | "changesRequested",
    body: string,
    threads: readonly Commented[],
  ): Change => {
    const id = fresh("R");
    const all = pull.threads ?? { items: [], total: 0 };
    return {
      next: {
        ...pull,
        timeline: event({ kind: "review", id, state, body, by, at }),
        threads: threads.reduce(
          (page, each) => added(page, thread(id, each)),
          all,
        ),
      },
      echo: { kind: "review", id },
    };
  };
  const states = {
    comment: "commented",
    approve: "approved",
    requestChanges: "changesRequested",
  } as const;
  switch (write.kind) {
    case "singleComment":
      return reviewed("commented", "", [write]);
    case "submitReview":
      return reviewed(states[write.event], write.body, write.threads);
    case "submitPending":
      return {
        next: {
          ...pull,
          pending: { kind: "none" },
          timeline: event({
            kind: "review",
            id: write.review,
            state: states[write.event],
            body: write.body,
            by,
            at,
          }),
        },
        echo: { kind: "review", id: write.review },
      };
    case "reply": {
      const comment = said(write.body);
      return {
        next: threadsOf(pull, write.thread, (each) => ({
          ...each,
          comments: added(each.comments, comment),
        })),
        echo: { kind: "comment", id: comment.id },
      };
    }
    case "resolve":
    case "unresolve": {
      const resolved = write.kind === "resolve";
      return {
        next: threadsOf(pull, write.thread, (each) => ({
          ...each,
          resolved,
          can: { ...each.can, resolve: !resolved, unresolve: resolved },
        })),
        echo: { kind: "thread", id: write.thread, resolved },
      };
    }
    case "comment": {
      const comment = said(write.body);
      return {
        next: { ...pull, timeline: event({ kind: "comment", ...comment }) },
        echo: { kind: "comment", id: comment.id },
      };
    }
    case "merge": {
      if (pull.state.kind !== "open")
        return { refused: "GitHub didn't do it: Pull request is not open." };
      if (pull.head.oid !== write.expectedHead)
        return {
          refused:
            "GitHub didn't do it: Head branch was modified. Review and try merging again.",
        };
      const commit = "9".repeat(40);
      return {
        next: {
          ...pull,
          state: { kind: "merged", at },
          timeline: event({
            kind: "merged",
            id: fresh("M"),
            oid: commit,
            by,
            at,
          }),
          head: {
            ...pull.head,
            ref: pull.merge.deletesBranch ? null : pull.head.ref,
          },
        },
        echo: { kind: "merged", commit },
      };
    }
    case "deleteHeadBranch": {
      if (pull.head.ref === null)
        return { next: pull, echo: { kind: "branchDeleted" } };
      if (pull.state.kind !== "merged" || pull.head.ref.othersOpen > 0)
        return { refused: `L1 Git kept ${write.branch}.` };
      return {
        next: {
          ...pull,
          head: { ...pull.head, ref: null },
          timeline: event({ kind: "branchDeleted", id: fresh("D"), by, at }),
        },
        echo: { kind: "branchDeleted" },
      };
    }
  }
}

/** The host's write op, by writes.rs's rules, over `host.details`. */
export function writeHandler(
  asLogin: string,
  write: PullWrite,
  host: Host,
): Written {
  const { github } = host.status;
  if (github.kind !== "connected")
    return {
      kind: "notSent",
      message: "L1 Git is not connected to GitHub, so it sent nothing.",
    };
  if (github.login.toLowerCase() !== asLogin.toLowerCase())
    return {
      kind: "notSent",
      message: `L1 Git is signed in to GitHub as ${github.login}, not ${asLogin}, so it sent nothing.`,
    };
  const script = host.writes.shift() ?? { kind: "done" };
  if (script.kind === "notSent" || script.kind === "refused")
    return {
      kind: script.kind,
      message: script.message ?? `The fake answers ${script.kind}.`,
    };
  const found = find(host.details, write);
  if (!found)
    return {
      kind: "refused",
      message: "GitHub didn't do it: Could not resolve to a node.",
    };
  const [key, pull] = found;
  const changed = change(write, pull, github.login);
  if ("refused" in changed)
    return { kind: "refused", message: changed.refused };
  if (script.kind === "done") {
    host.details.set(key, changed.next);
    return { kind: "done", echo: changed.echo };
  }
  if (script.applied) host.details.set(key, changed.next);
  return { kind: "unknown", message: "The fake heard no answer." };
}
