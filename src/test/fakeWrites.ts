import type { Carried, HostStatus, Wrote } from "../domain/host";
import { draftKey } from "../domain/drafts";
import type { Draft, PullDrafts } from "../domain/drafts";
import type {
  PullRequest,
  ReviewThread,
  TimelineEvent,
} from "../domain/pullRequest";
import type { Echo, PullWrite, Written } from "../domain/pullRequestWrites";
import { giveBack, viewOf } from "./fakeDrafts";
import type { FakeSent, Shelf } from "./fakeDrafts";

/** What the next write answers. A write with none left is done. */
export type WriteScript =
  | { kind: "done" }
  | { kind: "refused"; message?: string }
  | { kind: "notSent"; message?: string }
  /** Sent with no answer. `applied` says whether GitHub did it anyway, and
   * "later" holds it back until `applyLater`, as a GitHub still working on
   * it when the answer was lost. */
  | { kind: "unknown"; applied: boolean | "later" };

type Host = Shelf & {
  status: HostStatus;
  details: Map<string, PullRequest>;
  writes: WriteScript[];
  /** Every write that reached GitHub, in order. */
  mutations: PullWrite[];
};

type Commented = Pick<
  Extract<PullWrite, { kind: "singleComment" }>,
  "lines" | "body"
>;

type Change = { next: PullRequest; echo: Echo } | { refused: string };

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

/** A write GitHub can do twice without harm settles from state. */
const harmless = new Set<PullWrite["kind"]>([
  "resolve",
  "unresolve",
  "merge",
  "deleteHeadBranch",
]);

/** Changes `details` as GitHub would for `write`, or says why it wouldn't. */
function apply(host: Host, write: PullWrite, by: string): Change {
  const found = find(host.details, write);
  if (!found)
    return { refused: "GitHub didn't do it: Could not resolve to a node." };
  const [key, pull] = found;
  const changed = change(write, pull, by);
  if ("next" in changed) host.details.set(key, changed.next);
  return changed;
}

/** What a read shows of a write the host kept, as writes/evidence.rs reads
 * GitHub. */
function seen(record: FakeSent) {
  if (record.applied === true)
    return { kind: "landed" as const, echo: echoOf(record.write) };
  if (!harmless.has(record.write.kind)) return null;
  return {
    kind: "notLanded" as const,
    message: "GitHub hasn't done it.",
  };
}

function echoOf(write: PullWrite): Echo {
  switch (write.kind) {
    case "resolve":
    case "unresolve":
      return {
        kind: "thread",
        id: write.thread,
        resolved: write.kind === "resolve",
      };
    case "merge":
      return { kind: "merged", commit: "9".repeat(40) };
    case "deleteHeadBranch":
      return { kind: "branchDeleted" };
    case "submitPending":
      return { kind: "review", id: write.review };
    case "singleComment":
    case "submitReview":
      return { kind: "review", id: null };
    case "reply":
    case "comment":
      return { kind: "comment", id: null };
  }
}

type Asked = {
  asLogin: string;
  repository: { owner: string; repo: string };
  number: number;
};

const bookOf = ({ asLogin, repository, number }: Asked) =>
  `${asLogin} ${repository.owner}/${repository.repo}#${number}`.toLowerCase();

function signedIn(host: Host, asLogin: string): string | Written {
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
  return github.login;
}

const alone = (written: Written): Wrote => ({ written, drafts: null });
const held = (message: string): Written => ({ kind: "notSent", message });

/** Sends `record`'s write, now that it is kept, and answers by `script`.
 * Only a first send that GitHub didn't do gives its drafts back. */
function send(
  host: Host,
  book: string,
  record: FakeSent,
  by: string,
  again = false,
) {
  const script = host.writes.shift() ?? { kind: "done" };
  const answer = (written: Written): Wrote => {
    record.sending = false;
    if (written.kind === "done")
      host.sent.set(
        book,
        (host.sent.get(book) ?? []).filter((sent) => sent !== record),
      );
    else if (written.kind !== "unknown" && !again)
      giveBack(host, book, record.attempt, false);
    return { written, drafts: viewOf(host, book) };
  };
  if (script.kind === "notSent" || script.kind === "refused")
    return answer({
      kind: script.kind,
      message: script.message ?? `The fake answers ${script.kind}.`,
    });
  host.mutations.push(record.write);
  if (script.kind === "unknown") {
    if (script.applied === true) apply(host, record.write, by);
    record.applied = script.applied;
    return answer({ kind: "unknown", message: "The fake heard no answer." });
  }
  const changed = apply(host, record.write, by);
  if ("refused" in changed)
    return answer({ kind: "refused", message: changed.refused });
  return answer({ kind: "done", echo: changed.echo });
}

/**
 * The host's write op, by writes.rs's rules: on arrival, before the bridge
 * holds it, it takes the pull request and keeps the write with its drafts;
 * the answer it gives when released sends it.
 */
export function writeArrives(
  request: Asked & { attempt: string; write: PullWrite; drafts: Carried[] },
  host: Host,
): () => Wrote {
  const by = signedIn(host, request.asLogin);
  if (typeof by !== "string") return () => alone(by);
  const book = bookOf(request);
  const view = (): PullDrafts => viewOf(host, book);
  if ((host.sent.get(book) ?? []).length > 0)
    return () => ({
      written: held(
        "Another write for this pull request is sending, or may have posted, so L1 Git sent nothing.",
      ),
      drafts: view(),
    });
  const drafts = host.drafts.get(book) ?? [];
  const taken: Draft[] = [];
  for (const { anchor, head, at } of request.drafts) {
    const found = drafts.find(
      (draft) =>
        draftKey(draft.anchor, draft.head) === draftKey(anchor, head) &&
        draft.savedAt === at,
    );
    if (!found)
      return () => ({
        written: held(
          "A draft changed or went away since this window read it, so L1 Git sent nothing.",
        ),
        drafts: view(),
      });
    taken.push(found);
  }
  host.drafts.set(
    book,
    drafts.filter((draft) => !taken.includes(draft)),
  );
  const record: FakeSent = {
    attempt: request.attempt,
    at: Date.now(),
    write: request.write,
    drafts: taken,
    sending: true,
    applied: false,
  };
  host.sent.set(book, [record]);
  return () => send(host, book, record, by);
}

/** Send anyway, by writes.rs's rules: a write GitHub shows already is done
 * without sending. */
export function sendAgainArrives(
  request: Asked & { attempt: string },
  host: Host,
): () => Wrote {
  const by = signedIn(host, request.asLogin);
  if (typeof by !== "string") return () => alone(by);
  const book = bookOf(request);
  const record = host.sent
    .get(book)
    ?.find(({ attempt }) => attempt === request.attempt);
  if (!record || record.sending)
    return () => ({
      written: held(
        "This write isn't waiting anymore, so L1 Git sent nothing.",
      ),
      drafts: viewOf(host, book),
    });
  record.sending = true;
  const shown = seen(record);
  if (shown?.kind === "landed")
    return () => {
      host.sent.set(
        book,
        (host.sent.get(book) ?? []).filter((sent) => sent !== record),
      );
      return {
        written: { kind: "done", echo: shown.echo },
        drafts: viewOf(host, book),
      };
    };
  return () => send(host, book, record, by, true);
}

/** The host's check op: settles what a read shows, keeps the rest. */
export function checkHandler(request: Asked, host: Host) {
  const book = bookOf(request);
  const settled = [];
  for (const record of host.sent.get(book) ?? []) {
    if (record.sending) continue;
    const shown = seen(record);
    if (!shown) continue;
    if (shown.kind === "landed")
      host.sent.set(
        book,
        (host.sent.get(book) ?? []).filter((sent) => sent !== record),
      );
    else giveBack(host, book, record.attempt, false);
    settled.push({ attempt: record.attempt, write: record.write, seen: shown });
  }
  return { settled, drafts: viewOf(host, book) };
}

/** GitHub finishes every write it heard and held back. */
export function applyLater(host: Host) {
  const { github } = host.status;
  const by = github.kind === "connected" ? github.login : "octo";
  for (const records of host.sent.values())
    for (const record of records)
      if (record.applied === "later") {
        apply(host, record.write, by);
        record.applied = true;
      }
}
